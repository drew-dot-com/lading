/**
 * The Lading client as a library: the party that pays, and the one that
 * composes legs. `cli.ts` is a thin layer over this; `gate.ts` runs the same
 * code on the node behind an x402 door. Nothing here reads `process.argv`, and
 * every line that used to be printed goes through `opts.log`, so a caller
 * decides where progress lines land (a terminal, a request log, nowhere).
 *
 * Coordination lives here, not in the handler: that is the pattern every TOON
 * app follows (a handler is a leaf), and it keeps the broker unable to spend
 * on the payer's behalf beyond the one leg it was paid for.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ToonClient, buildJobEvent, sendJob, chargeFor } from '@toon-protocol/client';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { LEG_KIND, type FilecoinReceipt, type IpfsReceipt, type LegReceipt, type NameReceipt, type PartReceipt, type WalrusExtendReceipt, type WalrusReceipt, type WalrusRenewReceipt } from './kinds.js';
import { assembleParts, DEFAULT_PART_BYTES, partName, planParts, splitParts, type Part, type PartPlan } from './parts.js';
import type { FilecoinQuote, IpfsQuote, NameQuote, WalrusExtendQuote, WalrusQuote, WalrusRenewQuote } from './quote.js';
import { dueWithin, fmtDate, walrusRecords, type RenewalRow, type SavedPut, type SavedRenewal } from './renewals.js';
import { daysLeft } from './ledger.js';
import { buildManifest, parseManifest, type ManifestContent } from './manifest.js';
import { undernameFor } from './arns.js';
import { manifestFromPage, PAGE_CONTENT_TYPE, PATHS_CONTENT_TYPE, pathManifest, renderPage } from './page.js';
import { ARWEAVE_TXID_RE, DEFAULT_ARNS_GATEWAYS, DEFAULT_IPFS_GATEWAY, DEFAULT_IPFS_GATEWAYS, arnsReadUrls, arweaveReadUrls, ipfsReadUrls, readFirst, readGateways, viaNote } from './read.js';

export interface Routes {
  ario: string;
  walrus: string;
  walrusQuote: string;
  walrusRenew: string;
  walrusRenewQuote: string;
  walrusExtend: string;
  walrusExtendQuote: string;
  filecoin: string;
  filecoinQuote: string;
  ipfs: string;
  ipfsQuote: string;
  name: string;
  nameQuote: string;
  relay: string;
}

export interface LadingOptions {
  /** The edge connector the payer opens its channel with. */
  edge: string;
  routes: Routes;
  /** AR.IO gateway used to resolve ArNS names and to print read URLs. */
  gateway: string;
  /** Gateways tried in order for raw Arweave txid reads; `gateway` always goes first. */
  readGateways: string[];
  /** Gateways an ArNS name may fall back to; must resolve from the same registry as `gateway` (see read.ts). */
  arnsGateways: string[];
  lighthouseX402: string;
  walrusAggregator: string;
  /** IPFS gateways a CID is read back from, the pinner's own first. */
  ipfsGateways: string[];
  /** Where saved manifests, progress files and (by default) the payer's Nostr key live. */
  home: string;
  /** Path to a Solana keypair JSON array: the TOON payer. Ignored when `solanaSecret` is set. */
  solanaKeypair: string;
  /** The payer's 64-byte secret directly (SOLANA_KEYPAIR_JSON in the environment), for a container that mounts no file. */
  solanaSecret?: Uint8Array;
  solanaRpc: string;
  channelStore: string;
  /** Collateral locked when a channel has to be opened, base units. */
  channelDeposit: bigint;
  /** Hex Nostr secret; when absent one is read from, or written to, `<home>/nostr.key`. */
  nostrKey?: string;
  /** A hosted gate whose free verify door the bill of lading page offers as a second opinion (`LADING_GATE_URL`); empty = no such button. */
  gateUrl?: string;
  /** Progress lines. */
  log: (line: string) => void;
}

/** Where the page's footer sends a reader for the source. */
export const REPO_URL = 'https://github.com/drew-dot-com/lading';

const env = (k: string, d: string) => process.env[k] ?? d;

/** The options the CLI has always used: defaults, overridable one env var at a time. */
export function optionsFromEnv(overrides: Partial<LadingOptions> = {}): LadingOptions {
  const home = overrides.home ?? env('LADING_HOME', join(homedir(), '.lading'));
  return {
    edge: env('TOON_EDGE', 'https://connector.167-233-221-236.sslip.io'),
    routes: {
      ario: env('LADING_ROUTE_ARIO', 'g.drew.ario'),
      walrus: env('LADING_ROUTE_WALRUS', 'g.drew.lading.walrus'),
      walrusQuote: env('LADING_ROUTE_WALRUS_QUOTE', 'g.drew.lading.walrus.quote'),
      walrusRenew: env('LADING_ROUTE_WALRUS_RENEW', 'g.drew.lading.walrus.renew'),
      walrusRenewQuote: env('LADING_ROUTE_WALRUS_RENEW_QUOTE', 'g.drew.lading.walrus.renew.quote'),
      walrusExtend: env('LADING_ROUTE_WALRUS_EXTEND', 'g.drew.lading.walrus.extend'),
      walrusExtendQuote: env('LADING_ROUTE_WALRUS_EXTEND_QUOTE', 'g.drew.lading.walrus.extend.quote'),
      filecoin: env('LADING_ROUTE_FILECOIN', 'g.drew.lading.filecoin'),
      filecoinQuote: env('LADING_ROUTE_FILECOIN_QUOTE', 'g.drew.lading.filecoin.quote'),
      ipfs: env('LADING_ROUTE_IPFS', 'g.drew.lading.ipfs'),
      ipfsQuote: env('LADING_ROUTE_IPFS_QUOTE', 'g.drew.lading.ipfs.quote'),
      name: env('LADING_ROUTE_NAME', 'g.drew.lading.name'),
      nameQuote: env('LADING_ROUTE_NAME_QUOTE', 'g.drew.lading.name.quote'),
      relay: env('LADING_ROUTE_RELAY', 'g.drew.relay'),
    },
    gateway: env('LADING_ARNS_GATEWAY', 'permagate.io'),
    readGateways: readGateways(env('LADING_ARNS_GATEWAY', 'permagate.io'), process.env.LADING_READ_GATEWAYS),
    arnsGateways: readGateways(env('LADING_ARNS_GATEWAY', 'permagate.io'), process.env.LADING_ARNS_GATEWAYS, DEFAULT_ARNS_GATEWAYS),
    lighthouseX402: env('LIGHTHOUSE_X402_URL', 'https://x402-walrus.lighthouse.storage'),
    walrusAggregator: env('WALRUS_AGGREGATOR_URL', 'https://aggregator.walrus-mainnet.walrus.space'),
    ipfsGateways: readGateways(env('LADING_IPFS_GATEWAY', DEFAULT_IPFS_GATEWAY), process.env.LADING_IPFS_GATEWAYS, DEFAULT_IPFS_GATEWAYS),
    home,
    solanaKeypair: env('SOLANA_KEYPAIR', join(homedir(), '.config/solana/id.json')),
    solanaSecret: process.env.SOLANA_KEYPAIR_JSON ? Uint8Array.from(JSON.parse(process.env.SOLANA_KEYPAIR_JSON) as number[]) : undefined,
    solanaRpc: env('SOLANA_RPC', 'https://api.mainnet-beta.solana.com'),
    channelStore: env('LADING_CHANNEL_STORE', join(home, 'channel-store.json')),
    channelDeposit: BigInt(env('LADING_CHANNEL_DEPOSIT', '2000000')),
    nostrKey: process.env.LADING_NOSTR_KEY,
    gateUrl: env('LADING_GATE_URL', 'https://lading.167-233-221-236.sslip.io').replace(/\/+$/, '') || undefined,
    log: (line) => console.log(line),
    ...overrides,
  };
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Packet expiry for a Filecoin leg job. The edge accepted 600 s and 900 s expiries on 2026-09-08. */
export const FILECOIN_JOB_TIMEOUT_MS = Number(process.env.LADING_FILECOIN_JOB_TIMEOUT_MS ?? 600_000);

/** USDC/USDFC decimal strings compared in micro-units, as quote.ts does. */
export const micro = (v: string): bigint => {
  const [i, f = ''] = v.split('.');
  return BigInt(i || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const timesMicro = (v: string, n: number) => (Number(micro(v) * BigInt(n)) / 1e6).toFixed(6);
/** Decimal strings in 18 places, for amounts in any asset (USDC has 6, WAL and SUI 9). */
const atto = (v: string): bigint => {
  const [i, f = ''] = v.trim().split('.');
  return BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
};
const timesDecimal = (v: string, n: number) => {
  const u = atto(v) * BigInt(n);
  return `${u / 10n ** 18n}.${(u % 10n ** 18n).toString().padStart(18, '0')}`.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
};
/** What a walrus quote says the write costs downstream, in the float's asset: `amount`/`asset` when the door sent them, else the Lighthouse USDC. */
/** Drop the rows of networks not chosen (a leg and its quote door share the network's name); the finish rows always stay. */
const onlyNetworks = (networks: readonly Network[], rows: QuoteRow[]) =>
  rows.filter((r) => {
    const net = r.leg.replace(/-quote$/, '');
    return !(NETWORKS as readonly string[]).includes(net) || networks.includes(net as Network);
  });

const walrusNeed = (q: WalrusQuote, n: number) => {
  const asset = q.downstream.asset ?? 'USDC';
  const amount = q.downstream.amount ?? q.downstream.amountUsdc;
  return { asset, need: timesDecimal(amount, n), short: q.deliverable && n > 1 && atto(q.float.balance) < atto(amount) * BigInt(n) };
};

export type Paid<T> = { receipt: T; route: string; price: bigint | null };

/** What the payer's channel with the edge holds, in base units. */
export interface ChannelState {
  channelId: string;
  nonce: number;
  spent: bigint;
  deposit: bigint;
  available: bigint;
}
/** The slice of the client's `channel` facade Lading uses. */
type FacadeState = { channelId: string; nonce: number; spent: bigint; depositTotal: bigint; available: bigint };
type ChannelFacade = { state(o?: { onChain?: boolean }): Promise<FacadeState>; deposit(amount: bigint): Promise<FacadeState> };
/** Units kept free above a job's own price, so a route whose terms moved a little between the quote and the claim still clears. */
const HEADROOM_MARGIN = 5_000n;
/** Tries for a claim the edge refuses against a deposit figure a top-up just raised, and the pause between them. */
const UNDERCOLLATERAL_RETRIES = 4;
const UNDERCOLLATERAL_PAUSE_MS = 5_000;
export type Network = 'arweave' | 'walrus' | 'filecoin' | 'ipfs';
/** Every storage network a put buys, in the order the legs run. Arweave and Walrus are required for a finish; Filecoin and IPFS are skipped when their quote refuses. */
export const NETWORKS = ['arweave', 'walrus', 'filecoin', 'ipfs'] as const;
export interface PaidRow {
  leg: string;
  route: string;
  price: bigint | null;
}

/** Parts bought so far for one object, so a put that dies mid-way resumes where it stopped instead of paying twice. */
interface Progress {
  legs: Partial<Record<Network, LegReceipt>>;
  parts: Partial<Record<Network, PartReceipt[]>>;
  paid: Array<{ leg: string; route: string; price: string | null }>;
}

/** One part's outcome on one network, in the shape every door's receipt reduces to. */
interface PartOutcome {
  id: string;
  /** The sha256 the door reported, when it reports one; checked against the part. */
  sha256?: string;
  proof?: Record<string, string | number | undefined>;
  retention: string;
  provider: string;
  route: string;
  price: bigint | null;
}

export interface PutOptions {
  /** File name recorded with each leg; parts are named `<name>.partN`. */
  name: string;
  mime?: string;
  undername?: string;
  partBytes?: number;
  /** Quote each broker leg before paying it (default true). */
  quote?: boolean;
  /**
   * Legs to leave out. `arweave` keeps everything off Arweave (no manifest,
   * page or name either); `arweaveObject` keeps only the object's bytes off it,
   * the bill of lading still anchored there (what a door's network choice means).
   * `page` leaves out the public page and the path manifest, and with them the
   * name (a name has nothing to point at without them); `name` leaves out the
   * name alone. A door without `arns` chosen sets both.
   */
  skip?: Partial<Record<'arweave' | 'arweaveObject' | 'walrus' | 'filecoin' | 'ipfs' | 'relay' | 'page' | 'name', boolean>>;
  /** Walrus storage period in two-week epochs, 1..53; unset = the broker's default (26). Set, the native writer takes the leg. */
  walrusEpochs?: number;
  /** Recorded on the manifest when the put came through a door other than the CLI. */
  via?: ManifestContent['via'];
  /** Archive again even when this home already holds a manifest for the same bytes (default false: the saved record is returned, nothing re-bought). */
  force?: boolean;
}

export interface PutResult {
  sha256: string;
  size: number;
  parts: number;
  payerPubkey: string;
  legs: LegReceipt[];
  manifest: NostrEvent;
  manifestTxId?: string;
  /** The rendered bill of lading page and the path manifest the name points at (the page at `/`, the JSON at `/manifest.json`). */
  pageTxId?: string;
  pathsTxId?: string;
  name?: NameReceipt;
  paid: PaidRow[];
  /** Base units across every job, unknown prices counted as 0. */
  total: bigint;
  savedPath: string;
  manifestUrl?: string;
  /** True when no leg ran: a manifest for these bytes was already saved under `home` and is what this result carries. */
  reused?: boolean;
  /** Unix seconds the manifest was signed. */
  archivedAt: number;
}

export interface PartPutOptions {
  /** The whole object's sha256 and size; the plan is recomputed from them. */
  sha256: string;
  size: number;
  index: number;
  count: number;
  partBytes?: number;
  /** The slice's own sha256 when the caller declared one; checked against the bytes. */
  partSha256?: string;
  name: string;
  mime?: string;
  quote?: boolean;
  skip?: PutOptions['skip'];
  walrusEpochs?: number;
}

export interface PartResult {
  sha256: string;
  size: number;
  index: number;
  count: number;
  part: { sha256: string; size: number };
  /** The receipt each network handed back for this slice, sealed or not. */
  receipts: Partial<Record<Network, PartReceipt>>;
  /** Networks that did not buy this slice (a refused quote). */
  missing: Network[];
  paid: PaidRow[];
  total: bigint;
  /** The object already has a bill of lading; nothing was bought. */
  archived?: boolean;
}

export interface FinishOptions {
  sha256: string;
  size: number;
  count: number;
  partBytes?: number;
  name: string;
  mime?: string;
  undername?: string;
  quote?: boolean;
  skip?: PutOptions['skip'];
  via?: ManifestContent['via'];
  force?: boolean;
}

export interface PartsStatus {
  sha256: string;
  archived: boolean;
  manifestTxId?: string;
  name?: string;
  networks: Partial<Record<Network, { indexes: number[]; sealed: boolean }>>;
  paidUnits: string;
}

/** A caller's mistake (a plan that does not match, a hash that does not match the bytes, nothing bought yet): a door answers 400, never 5xx. */
export class InputError extends Error {}

/** A finish that cannot seal: which indexes each network still lacks. */
export class PartsMissingError extends Error {
  constructor(
    readonly sha256: string,
    readonly missing: Partial<Record<Network, number[]>>,
  ) {
    super(`parts missing: ${Object.entries(missing).map(([k, v]) => `${k} ${v.join(',')}`).join('; ')}; send them to /v1/parts again, or skip that network`);
  }
}

export interface QuoteRow {
  leg: string;
  route: string;
  price: bigint | null;
  note: string;
}
export interface QuoteResult {
  sha256: string;
  size: number;
  parts: number;
  largestPart: number;
  rows: QuoteRow[];
  total: bigint;
  /** What the three quote doors cost to ask. */
  quotesPaid: bigint;
}

/** The bill without asking any door: route prices only, every leg assumed deliverable. Free. */
export interface Estimate {
  size: number;
  parts: number;
  rows: QuoteRow[];
  total: bigint;
  /** Routes the edge would not price; the total is a floor when this is non-empty. */
  unpriced: string[];
}

export interface VerifyLegRow {
  label: string;
  id: string;
  ok: boolean;
  detail: string;
}
export interface VerifyResult {
  pubkey: string;
  sha256: string;
  size: number;
  legs: number;
  rows: VerifyLegRow[];
  ok: boolean;
  manifest: ManifestContent;
  /** Where the manifest was read from, with any gateways that failed first. */
  source: string;
}

export interface RenewResult {
  rows: Array<{
    label: string;
    provider: 'lighthouse' | 'native';
    /** The Lighthouse record id or the Sui blob object id. */
    handle: string;
    lighthouseId: string;
    blobId?: string;
    previousExpiresAt?: number;
    expiresAt?: number;
    previousEndEpoch?: number;
    endEpoch?: number;
    baseTx?: string;
    digest?: string;
    skipped?: string;
    recorded: boolean;
  }>;
  bought: number;
  targets: number;
  total: bigint;
}

export class Lading {
  readonly opts: LadingOptions;
  private c?: Promise<ToonClient>;
  private terms = new Map<string, { at: number; terms: unknown | null }>();

  constructor(opts: LadingOptions) {
    this.opts = opts;
  }

  private log(line: string) {
    this.opts.log(line);
  }

  private nostrSecret(): Uint8Array {
    if (this.opts.nostrKey) return Uint8Array.from(Buffer.from(this.opts.nostrKey, 'hex'));
    mkdirSync(this.opts.home, { recursive: true });
    const p = join(this.opts.home, 'nostr.key');
    if (!existsSync(p)) {
      writeFileSync(p, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
      this.log(`new payer identity written to ${p}`);
    }
    return Uint8Array.from(Buffer.from(readFileSync(p, 'utf8').trim(), 'hex'));
  }

  /** The payer's Nostr pubkey, the key every manifest is signed with. */
  payerPubkey(): string {
    return getPublicKey(this.nostrSecret());
  }

  /** One ToonClient per Lading, opened on first use. */
  client(): Promise<ToonClient> {
    if (!this.c) {
      mkdirSync(this.opts.home, { recursive: true });
      this.c = ToonClient.create({
        connector: this.opts.edge,
        solanaSecretKey: this.opts.solanaSecret ?? Uint8Array.from(JSON.parse(readFileSync(this.opts.solanaKeypair, 'utf8')) as number[]),
        evmPrivateKey: ('0x' + randomBytes(32).toString('hex')) as `0x${string}`,
        chain: 'solana',
        rpcUrl: this.opts.solanaRpc,
        transport: 'http',
        channelStore: this.opts.channelStore,
        autoOpenChannel: true,
        // Collateral locked when a channel has to be opened (base units). The
        // client's own default is 100,000, one small put; a chunked put runs to
        // several hundred thousand, so start with 2 USDC. Unspent deposit comes
        // back when the channel settles.
        deposit: this.opts.channelDeposit,
      } as never) as Promise<ToonClient>;
    }
    return this.c;
  }

  async close() {
    if (!this.c) return;
    const c = await this.c;
    await (c as { close?: () => Promise<void> }).close?.();
    this.c = undefined;
  }

  /** The open channel's deposit as last read on chain, so headroom needs no chain round trip per job. */
  private depositKnown?: bigint;

  /**
   * The payer's channel with the edge as the client tracks it: what is
   * deposited (read on chain once, then after each top-up), what the claims
   * so far add up to, and what is left. `undefined` when no channel is open
   * yet (the first paid job opens one with the configured deposit).
   */
  async channelState(): Promise<ChannelState | undefined> {
    const c = await this.client();
    const ch = (c as unknown as { channel?: ChannelFacade }).channel;
    if (!ch) return undefined;
    let s: FacadeState;
    try {
      s = await ch.state(this.depositKnown === undefined ? { onChain: true } : {});
    } catch {
      return undefined;
    }
    if (this.depositKnown === undefined) this.depositKnown = s.depositTotal;
    const deposit = this.depositKnown;
    return { channelId: s.channelId, nonce: s.nonce, spent: s.spent, deposit, available: deposit > s.spent ? deposit - s.spent : 0n };
  }

  /**
   * A claim past the counterparty's deposit is refused by the edge ("could
   * never be redeemed"), and the client tops a channel up only when it opens
   * one. So before each job: if what is left of the deposit cannot cover it,
   * add another deposit's worth (monotonic on chain, one transaction) rather
   * than close, settle and reopen, which trips connector#1283 on Solana.
   */
  private async ensureHeadroom(need: bigint): Promise<void> {
    const s = await this.channelState();
    if (!s || s.available >= need) return;
    const add = this.opts.channelDeposit > need ? this.opts.channelDeposit : need;
    this.log(`channel  ${s.channelId.slice(0, 8)}… has ${s.available} units left and the next job needs ${need}: depositing ${add} more`);
    const c = await this.client();
    const r = await (c as unknown as { channel: ChannelFacade }).channel.deposit(add);
    this.depositKnown = r.depositTotal;
    this.log(`channel  ✓ deposit now ${r.depositTotal} units, ${r.available} left`);
  }

  // ---- files under home ----

  private manifestPath = (sha: string) => join(this.opts.home, 'manifests', `${sha}.json`);
  private progressPath = (sha: string) => join(this.opts.home, 'progress', `${sha}.json`);

  /** The local record of a put: written as soon as the manifest is on Arweave, so a later failed leg is resumable with `lading name`. */
  private save(sha: string, state: { manifest: NostrEvent; manifestTxId?: string; pageTxId?: string; pathsTxId?: string; name?: NameReceipt; paid: Array<{ leg: string; route: string; price: bigint | null | string }> }): string {
    mkdirSync(join(this.opts.home, 'manifests'), { recursive: true });
    const out = this.manifestPath(sha);
    writeFileSync(out, JSON.stringify({ ...state, paid: state.paid.map((p) => ({ ...p, price: p.price?.toString() })) }, null, 2));
    return out;
  }

  private loadProgress(sha: string): Progress {
    const p = this.progressPath(sha);
    if (!existsSync(p)) return { legs: {}, parts: {}, paid: [] };
    return JSON.parse(readFileSync(p, 'utf8')) as Progress;
  }
  private saveProgress(sha: string, prog: Progress) {
    mkdirSync(join(this.opts.home, 'progress'), { recursive: true });
    writeFileSync(this.progressPath(sha), JSON.stringify(prog, null, 2));
  }
  private clearProgress(sha: string) {
    if (existsSync(this.progressPath(sha))) rmSync(this.progressPath(sha));
  }

  /** Every saved put, oldest first. */
  savedPuts(): Array<{ path: string; sha: string; saved: SavedPut }> {
    const dir = join(this.opts.home, 'manifests');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
      .map((f) => ({ path: join(dir, f), sha: f.slice(0, 64), saved: JSON.parse(readFileSync(join(dir, f), 'utf8')) as SavedPut }))
      .sort((a, b) => a.saved.manifest.created_at - b.saved.manifest.created_at);
  }

  /** The saved put for one object hash, when this home holds one. */
  savedPut(sha: string): { path: string; saved: SavedPut } | undefined {
    if (!/^[0-9a-f]{64}$/.test(sha)) return undefined;
    const p = this.manifestPath(sha);
    if (!existsSync(p)) return undefined;
    return { path: p, saved: JSON.parse(readFileSync(p, 'utf8')) as SavedPut };
  }

  /**
   * A saved put read back as a PutResult. Only a put whose manifest reached
   * Arweave counts: a record without `manifestTxId` is a put that died before
   * its manifest and is resumed through the progress file, not reused.
   */
  archived(sha: string): PutResult | undefined {
    const hit = this.savedPut(sha);
    if (!hit?.saved.manifestTxId) return undefined;
    const { saved, path } = hit;
    const content = parseManifest(saved.manifest);
    const paid: PaidRow[] = (saved.paid as Array<{ leg: string; route: string; price: string | null | undefined }>).map((p) => ({
      leg: p.leg,
      route: p.route,
      price: p.price === null || p.price === undefined ? null : BigInt(p.price),
    }));
    return {
      sha256: sha,
      size: content.size,
      parts: Math.max(1, ...content.legs.map((l) => l.parts?.length ?? 1)),
      payerPubkey: saved.manifest.pubkey,
      legs: content.legs,
      manifest: saved.manifest,
      manifestTxId: saved.manifestTxId,
      pageTxId: saved.pageTxId,
      pathsTxId: saved.pathsTxId,
      name: saved.name as NameReceipt | undefined,
      paid,
      total: paid.reduce((a, p) => a + (p.price ?? 0n), 0n),
      savedPath: path,
      manifestUrl: `https://${this.opts.gateway}/${saved.manifestTxId}`,
      reused: true,
      archivedAt: saved.manifest.created_at,
    };
  }

  // ---- pricing ----

  /** The route's terms from the edge, cached for a minute: a schedule, a flat price, or null when unpriced. */
  private async routeTerms(route: string): Promise<unknown | null> {
    const hit = this.terms.get(route);
    if (hit && Date.now() - hit.at < 60_000) return hit.terms;
    const c = await this.client();
    const terms = await c.routePrice(route).catch(() => null);
    this.terms.set(route, { at: Date.now(), terms });
    return terms;
  }

  /** What the route will charge for this event: the ADR 0065 schedule applied to the payload length, or the flat price. */
  async charge(route: string, payloadLen: number): Promise<bigint | null> {
    const terms = await this.routeTerms(route);
    if (!terms) return null;
    try {
      return chargeFor(terms as never, payloadLen) as bigint;
    } catch {
      const c = await this.client();
      return c.price(route).catch(() => null);
    }
  }

  private async job<T>(route: string, event: NostrEvent, timeoutMs = 180_000): Promise<Paid<T>> {
    const c = await this.client();
    const price = await this.charge(route, Buffer.byteLength(JSON.stringify({ event })));
    await this.ensureHeadroom((price ?? 0n) + HEADROOM_MARGIN);
    // The edge compares a claim against the deposit it last read and re-reads
    // the chain on a breach, but not more than once every couple of seconds
    // (connector claim_gate.rs `min_reattempt_interval`, default 2 s): a claim
    // sent right after a top-up can be refused against the old figure. Such a
    // refusal moves no watermark, so the same claim is good again shortly.
    for (let attempt = 1; ; attempt++) {
      const answer = await sendJob<T>({ client: c as never, destination: route, timeoutMs }, event as never);
      if (answer.accepted) return { receipt: answer.receipt, route, price };
      const stale = answer.code === 'F03' && /deposited on chain/.test(answer.message ?? '');
      if (!stale || attempt >= UNDERCOLLATERAL_RETRIES) throw new Error(`${route}: ${answer.code} ${answer.message}`);
      this.log(`channel  edge still holds the old deposit figure (${answer.message?.match(/more than the (\d+)/)?.[1] ?? '?'}); retrying in ${UNDERCOLLATERAL_PAUSE_MS / 1000} s (${attempt}/${UNDERCOLLATERAL_RETRIES})`);
      await new Promise((r) => setTimeout(r, UNDERCOLLATERAL_PAUSE_MS));
    }
  }

  /** Ask the walrus quote door whether an object of this size would go through right now. 1,000 units, against 40,000 for the leg. */
  quoteWalrus(size: number, name: string, epochs?: number): Promise<Paid<WalrusQuote>> {
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus', phase: 'quote', size: String(size), name, ...(epochs ? { epochs: String(epochs) } : {}) } });
    return this.job<WalrusQuote>(this.opts.routes.walrusQuote, ev as never, 60_000);
  }

  /** Ask the filecoin quote door whether the broker's Filecoin Pay account can carry one more piece right now. 1,000 units, against 30,000 for the leg. */
  quoteFilecoin(size: number, name: string): Promise<Paid<FilecoinQuote>> {
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'filecoin', phase: 'quote', size: String(size), name } });
    return this.job<FilecoinQuote>(this.opts.routes.filecoinQuote, ev as never, 60_000);
  }

  /** Ask the ipfs quote door what Pinata charges for a pin of this size and whether the Base key covers it. 1,000 units, against 5,000 for the leg. */
  quoteIpfs(size: number, name: string): Promise<Paid<IpfsQuote>> {
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'ipfs', phase: 'quote', size: String(size), name } });
    return this.job<IpfsQuote>(this.opts.routes.ipfsQuote, ev as never, 60_000);
  }

  /** Ask the name quote door whether the broker can write this undername right now. 1,000 units, against 5,000 for the leg. */
  quoteName(undername: string, txid?: string): Promise<Paid<NameQuote>> {
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'name', phase: 'quote', undername, ...(txid ? { txid } : {}) } });
    return this.job<NameQuote>(this.opts.routes.nameQuote, ev as never, 60_000);
  }

  /** Ask the renew quote door what one more year on a Lighthouse record costs and when it currently runs out. 1,000 units, against 40,000 for the renewal. */
  quoteWalrusRenew(lighthouseId: string): Promise<Paid<WalrusRenewQuote>> {
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus-renew', phase: 'quote', lighthouseId } });
    return this.job<WalrusRenewQuote>(this.opts.routes.walrusRenewQuote, ev as never, 60_000);
  }

  /** Ask the extend quote door what `epochs` more on a native Walrus blob object costs and where its period stands. 1,000 units, against 40,000 for the extension. */
  quoteWalrusExtend(objectId: string, epochs?: number): Promise<Paid<WalrusExtendQuote>> {
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus-extend', phase: 'quote', objectId, ...(epochs ? { epochs: String(epochs) } : {}) } });
    return this.job<WalrusExtendQuote>(this.opts.routes.walrusExtendQuote, ev as never, 60_000);
  }

  /** Bytes on the wire for a leg event carrying a blob of `blobLen` bytes (base64 grows it by a third). */
  private eventBytes(params: Record<string, string>, blobLen?: number) {
    return Buffer.byteLength(JSON.stringify({ event: buildJobEvent({ kind: LEG_KIND, params, tags: blobLen ? [['i', 'A'.repeat(Math.ceil(blobLen / 3) * 4), 'blob']] : [] }) }));
  }

  /** A manifest with four legs, plus part receipts, before signing. */
  private manifestGuess = (n: number) => 1200 + 4 * 400 + (n > 1 ? 4 * n * 400 : 0);
  /** The public page is the manifest rendered with its proofs and a verifier; the path manifest that names it is a few hundred bytes. */
  private pageGuess = (n: number) => 12_000 + this.manifestGuess(n);
  private static readonly PATHS_BYTES = 400;

  /** The finish rows a name adds: the page, its path manifest, the name quote, the name. */
  private async nameRows(n: number, quote: (route: string) => Promise<bigint | null>): Promise<QuoteRow[]> {
    const R = this.opts.routes;
    return [
      { leg: 'page', route: R.ario, price: await this.charge(R.ario, this.pageGuess(n)), note: 'bill of lading page on Arweave, estimate' },
      { leg: 'paths', route: R.ario, price: await this.charge(R.ario, Lading.PATHS_BYTES), note: 'path manifest on Arweave, estimate' },
      { leg: 'name-quote', route: R.nameQuote, price: await quote(R.nameQuote), note: 'quote door' },
      { leg: 'name', route: R.name, price: await this.charge(R.name, 0), note: 'flat' },
    ];
  }

  /** The bill for one slice of `size` bytes on the four networks, each quote door asked once: what the gate charges per `POST /v1/parts`. Free. */
  async estimatePart(size: number, networks: readonly Network[] = NETWORKS): Promise<Estimate> {
    const R = this.opts.routes;
    const rows: QuoteRow[] = onlyNetworks(networks, [
      { leg: 'arweave', route: R.ario, price: await this.charge(R.ario, this.eventBytes({}, size)), note: 'schedule on the payload' },
      { leg: 'walrus-quote', route: R.walrusQuote, price: await this.charge(R.walrusQuote, 0), note: 'quote door' },
      { leg: 'walrus', route: R.walrus, price: await this.charge(R.walrus, 0), note: 'flat' },
      { leg: 'filecoin-quote', route: R.filecoinQuote, price: await this.charge(R.filecoinQuote, 0), note: 'quote door' },
      { leg: 'filecoin', route: R.filecoin, price: await this.charge(R.filecoin, 0), note: 'flat' },
      { leg: 'ipfs-quote', route: R.ipfsQuote, price: await this.charge(R.ipfsQuote, 0), note: 'quote door' },
      { leg: 'ipfs', route: R.ipfs, price: await this.charge(R.ipfs, 0), note: 'flat' },
    ]);
    const unpriced = [...new Set(rows.filter((r) => r.price === null).map((r) => r.route))];
    return { size, parts: 1, rows, total: rows.reduce((a, r) => a + (r.price ?? 0n), 0n), unpriced };
  }

  /** The bill for the finish of an object in `n` parts: relay copy, manifest on Arweave, and with `arns` the page, path manifest, name quote and name. Free. */
  async estimateFinish(n: number, arns = false): Promise<Estimate> {
    const R = this.opts.routes;
    const rows: QuoteRow[] = [
      { leg: 'relay', route: R.relay, price: await this.charge(R.relay, this.manifestGuess(n)), note: 'manifest copy' },
      { leg: 'manifest', route: R.ario, price: await this.charge(R.ario, this.manifestGuess(n)), note: 'manifest on Arweave, estimate' },
      ...(arns ? await this.nameRows(n, (route) => this.charge(route, 0)) : []),
    ];
    const unpriced = [...new Set(rows.filter((r) => r.price === null).map((r) => r.route))];
    return { size: 0, parts: n, rows, total: rows.reduce((a, r) => a + (r.price ?? 0n), 0n), unpriced };
  }

  /**
   * The bill from route prices alone, every leg assumed deliverable and every
   * quote door asked once. Costs nothing: the edge's price endpoint is free.
   * This is what the gate charges against, so it is deliberately the ceiling
   * (a leg that is skipped at run time only makes the real bill smaller).
   */
  async estimate(size: number, partBytes = DEFAULT_PART_BYTES, networks: readonly Network[] = NETWORKS, arns = false): Promise<Estimate> {
    const R = this.opts.routes;
    const parts = planParts(size, partBytes);
    const n = parts.length;
    const unpriced: string[] = [];
    const perPart = async (route: string) => {
      let sum = 0n;
      for (const p of parts) {
        const one = await this.charge(route, this.eventBytes({}, p.size));
        if (one === null) return null;
        sum += one;
      }
      return sum;
    };
    const flat = async (route: string) => {
      const one = await this.charge(route, 0);
      return one === null ? null : one * BigInt(n);
    };
    const quote = async (route: string) => this.charge(route, 0);
    const partsNote = n > 1 ? ` × ${n} parts` : '';
    const rows: QuoteRow[] = onlyNetworks(networks, [
      { leg: 'arweave', route: R.ario, price: await perPart(R.ario), note: `schedule on the payload${partsNote}` },
      { leg: 'walrus-quote', route: R.walrusQuote, price: await quote(R.walrusQuote), note: 'quote door' },
      { leg: 'walrus', route: R.walrus, price: await flat(R.walrus), note: `flat${partsNote}` },
      { leg: 'filecoin-quote', route: R.filecoinQuote, price: await quote(R.filecoinQuote), note: 'quote door' },
      { leg: 'filecoin', route: R.filecoin, price: await flat(R.filecoin), note: `flat${partsNote}` },
      { leg: 'ipfs-quote', route: R.ipfsQuote, price: await quote(R.ipfsQuote), note: 'quote door' },
      { leg: 'ipfs', route: R.ipfs, price: await flat(R.ipfs), note: `flat${partsNote}` },
      { leg: 'relay', route: R.relay, price: await this.charge(R.relay, this.manifestGuess(n)), note: 'manifest copy' },
      { leg: 'manifest', route: R.ario, price: await this.charge(R.ario, this.manifestGuess(n)), note: 'manifest on Arweave, estimate' },
      ...(arns ? await this.nameRows(n, quote) : []),
    ]);
    for (const r of rows) if (r.price === null) unpriced.push(r.route);
    const total = rows.reduce((a, r) => a + (r.price ?? 0n), 0n);
    return { size, parts: n, rows, total, unpriced: [...new Set(unpriced)] };
  }

  // ---- legs ----

  /** The job that buys one part on one network, and how its outcome prints. */
  private legSender(network: Network, o: { name: string; mime?: string; walrusEpochs?: number }): { send: (part: Part, name: string) => Promise<PartOutcome>; line: (out: PartOutcome) => string } {
    const R = this.opts.routes;
    const blobEvent = (kind: number, params: Record<string, string>, part: Part, extra: string[][] = []) =>
      buildJobEvent({ kind, params, tags: [['i', Buffer.from(part.bytes).toString('base64'), 'blob'], ...extra] });
    // Arweave, through the org store. The store FULFILLs on the txId.
    if (network === 'arweave')
      return {
        send: async (part) => {
          const ev = blobEvent(5094, {}, part, [['bid', '100000', 'usdc'], ['output', o.mime ?? 'application/octet-stream']]);
          const r = await this.job<{ txId?: string }>(R.ario, ev as never);
          const txId = r.receipt.txId;
          if (!txId) throw new Error(`arweave leg accepted without a txId: ${JSON.stringify(r.receipt)}`);
          return { id: txId, proof: { readUrl: `https://${this.opts.gateway}/${txId}` }, retention: 'permanent', provider: 'toon-store', route: r.route, price: r.price };
        },
        line: (out) => out.id,
      };
    // Walrus, through Lading's door. Lading FULFILLs on the blobId.
    if (network === 'walrus')
      return {
        send: async (part, pname) => {
          const r = await this.job<WalrusReceipt>(R.walrus, blobEvent(LEG_KIND, { op: 'walrus', name: pname || o.name, ...(o.walrusEpochs ? { epochs: String(o.walrusEpochs) } : {}) }, part) as never, 240_000);
          return { id: r.receipt.id, sha256: r.receipt.sha256, proof: r.receipt.proof, retention: r.receipt.retention, provider: r.receipt.provider, route: r.route, price: r.price };
        },
        line: (out) => `${out.id}  readback=${out.proof?.readback}`,
      };
    // IPFS, through Lading's door. Lading FULFILLs on the CID once a gateway served the bytes back.
    if (network === 'ipfs')
      return {
        send: async (part, pname) => {
          const r = await this.job<IpfsReceipt>(R.ipfs, blobEvent(LEG_KIND, { op: 'ipfs', name: pname || o.name }, part) as never, 300_000);
          return { id: r.receipt.id, sha256: r.receipt.sha256, proof: r.receipt.proof, retention: r.receipt.retention, provider: r.receipt.provider, route: r.route, price: r.price };
        },
        line: (out) => `${out.id}  readback=${out.proof?.readback}`,
      };
    // Filecoin Onchain Cloud, through Lading's door. Lading FULFILLs on the PieceCID once the provider committed the piece and served it back.
    return {
      send: async (part, pname) => {
        // A provider commit can take five minutes on a slow day (313 s seen 2026-09-08); the edge abandons a packet at its expiry and the broker's spend is then for nothing, so give it ten.
        const r = await this.job<FilecoinReceipt>(R.filecoin, blobEvent(LEG_KIND, { op: 'filecoin', name: pname || o.name }, part) as never, FILECOIN_JOB_TIMEOUT_MS);
        return { id: r.receipt.id, sha256: r.receipt.sha256, proof: r.receipt.proof, retention: r.receipt.retention, provider: r.receipt.provider, route: r.route, price: r.price };
      },
      line: (out) => `${out.id}  dataSet=${out.proof?.dataSetId} copies=${out.proof?.copies} readback=${out.proof?.readback}`,
    };
  }

  /**
   * Buy the given parts on one network: reuse any already in the progress
   * file, pay for the rest one job at a time, save after each. `count` is the
   * whole object's part count, for the log tag and the part names. Nothing is
   * sealed here; sealLeg does that once every part of the object is in.
   */
  private async buyParts(o: { network: Network; sha: string; count: number; parts: Part[]; prog: Progress; paid: PaidRow[]; t0: number; baseName: string; mime?: string; walrusEpochs?: number }): Promise<void> {
    const { network, prog, count } = o;
    if (prog.legs[network]) return;
    const have = (prog.parts[network] ??= []);
    const { send, line } = this.legSender(network, { name: o.baseName, mime: o.mime, walrusEpochs: o.walrusEpochs });
    for (const part of o.parts) {
      const tag = count === 1 ? network.padEnd(8) : `${network}#${part.index + 1}/${count}`.padEnd(8);
      const prior = have.find((r) => r.index === part.index);
      if (prior) {
        if (prior.sha256 !== part.sha256) throw new Error(`${network} part ${part.index} was bought for a different slice (${prior.sha256.slice(0, 12)}); pass --part-bytes as before, or delete ${this.progressPath(o.sha)}`);
        this.log(`${tag} ✓ ${prior.id}  resumed, already bought`);
        continue;
      }
      const out = await send(part, partName(o.baseName, part.index, count));
      if (out.sha256 !== undefined && out.sha256 !== part.sha256) throw new Error(`${network} receipt is for sha ${out.sha256}, not ${part.sha256}`);
      const legLabel = count === 1 ? network : `${network}#${part.index + 1}`;
      o.paid.push({ leg: legLabel, route: out.route, price: out.price });
      prog.paid.push({ leg: legLabel, route: out.route, price: out.price?.toString() ?? null });
      have.push({ index: part.index, id: out.id, sha256: part.sha256, size: part.size, proof: { ...out.proof, retention: out.retention, provider: out.provider }, ...(out.price !== null ? { paid: out.price.toString() } : {}) });
      this.saveProgress(o.sha, prog);
      this.log(`${tag} ✓ ${line(out)}  (${Date.now() - o.t0} ms)`);
    }
  }

  /**
   * The leg receipt for one network once every part of the plan is in the
   * progress file: a single part gives the same leg shape as before chunking
   * existed, several give a leg with `parts`. Otherwise the indexes still missing.
   */
  private sealLeg(o: { network: Network; sha: string; size: number; plan: PartPlan[]; prog: Progress }): { leg?: LegReceipt; missing: number[] } {
    const { network, prog } = o;
    const done = prog.legs[network];
    if (done) {
      this.log(`${network.padEnd(8)} ✓ ${done.id}${done.parts ? ` (${done.parts.length} parts)` : ''}  resumed, already bought`);
      return { leg: done, missing: [] };
    }
    const have = prog.parts[network] ?? [];
    const rows = o.plan.map((p) => have.find((r) => r.index === p.index));
    const missing = o.plan.filter((_, i) => !rows[i]).map((p) => p.index);
    if (missing.length) return { missing };
    const receipts = rows as PartReceipt[];
    const first = receipts[0]!;
    const { retention: fr, provider: fp, ...firstProof } = first.proof ?? {};
    const known = receipts.every((r) => r.paid !== undefined);
    const paidStr = known ? receipts.reduce((a, r) => a + BigInt(r.paid!), 0n).toString() : undefined;
    const at = Math.floor(Date.now() / 1000);
    const retention = String(fr ?? '');
    const provider = String(fp ?? '');
    const leg: LegReceipt =
      receipts.length === 1
        ? { network, id: first.id, sha256: o.sha, size: o.size, retention, provider, proof: firstProof, ...(paidStr ? { paid: paidStr } : {}), at }
        : {
            network,
            id: first.id,
            sha256: o.sha,
            size: o.size,
            retention,
            provider,
            ...(paidStr ? { paid: paidStr } : {}),
            at,
            parts: receipts.map((r) => {
              const { retention: _r, provider: _p, ...proof } = r.proof ?? {};
              return { index: r.index, id: r.id, sha256: r.sha256, size: r.size, ...(Object.keys(proof).length ? { proof } : {}), ...(r.paid !== undefined ? { paid: r.paid } : {}) };
            }),
          };
    prog.legs[network] = leg;
    this.saveProgress(o.sha, prog);
    return { leg, missing: [] };
  }

  /** Seal every network that bought anything. A network with no parts at all was refused by its quote and is simply absent. */
  private sealAll(o: { sha: string; size: number; plan: PartPlan[]; prog: Progress; skip: PutOptions['skip'] }): { legs: LegReceipt[]; incomplete: Partial<Record<Network, number[]>> } {
    const legs: LegReceipt[] = [];
    const incomplete: Partial<Record<Network, number[]>> = {};
    for (const network of NETWORKS) {
      if (o.skip?.[network]) continue;
      if (!o.prog.legs[network] && !o.prog.parts[network]?.length) continue;
      const r = this.sealLeg({ network, sha: o.sha, size: o.size, plan: o.plan, prog: o.prog });
      if (r.leg) legs.push(r.leg);
      else incomplete[network] = r.missing;
    }
    return { legs, incomplete };
  }

  /**
   * The four legs over the given parts (all of them for a put, one for a
   * part call). Walrus, Filecoin and IPFS are quoted first for the largest
   * part: a leg the broker cannot deliver still costs its route price, and
   * with several parts the float must cover them all. A refused Walrus quote
   * throws (nothing paid); a refused Filecoin or IPFS quote skips that network.
   */
  private async runLegs(o: { sha: string; size: number; count: number; parts: Part[]; prog: Progress; paid: PaidRow[]; t0: number; name: string; mime?: string; skip: NonNullable<PutOptions['skip']>; quote: boolean; walrusEpochs?: number }): Promise<void> {
    const { prog, paid, t0, skip } = o;
    const largest = Math.max(...o.parts.map((x) => x.size));
    const left = (network: Network) => o.parts.filter((p) => !prog.parts[network]?.some((r) => r.index === p.index)).length;
    const common = { sha: o.sha, count: o.count, parts: o.parts, prog, paid, t0, baseName: o.name, mime: o.mime, walrusEpochs: o.walrusEpochs };

    if (!skip.arweave && !skip.arweaveObject) await this.buyParts({ ...common, network: 'arweave' });

    if (!skip.walrus && !prog.legs.walrus) {
      const n = left('walrus');
      if (o.quote && n > 0) {
        const q = await this.quoteWalrus(largest, o.name, o.walrusEpochs);
        paid.push({ leg: 'walrus-quote', route: q.route, price: q.price });
        const { asset, need, short } = walrusNeed(q.receipt, n);
        this.log(`walrus   quote ${fmtQuote(q.receipt)}${n > 1 ? `, ${n} parts need ${need} ${asset}` : ''}  (${Date.now() - t0} ms)`);
        if (!q.receipt.deliverable || short) throw new Error(`walrus leg would not go through; nothing paid for it. Re-run with --skip-walrus to archive without it. (${short ? `float ${q.receipt.float.balance} ${asset} is under the ${need} ${asset} that ${n} parts cost` : q.receipt.reason})`);
      }
      await this.buyParts({ ...common, network: 'walrus' });
    }

    if (!skip.filecoin && !prog.legs.filecoin) {
      const n = left('filecoin');
      let go = true;
      if (o.quote && n > 0) {
        const q = await this.quoteFilecoin(largest, o.name);
        paid.push({ leg: 'filecoin-quote', route: q.route, price: q.price });
        const need = timesMicro(q.receipt.downstream.addPieceFeeUsdfc, n);
        const short = q.receipt.deliverable && n > 1 && micro(q.receipt.float.available) < micro(need);
        this.log(`filecoin quote ${fmtQuote(q.receipt)}${n > 1 ? `, ${n} parts need ${need} USDFC in fees` : ''}  (${Date.now() - t0} ms)`);
        if (!q.receipt.deliverable || short) {
          go = false;
          this.log(`filecoin SKIPPED, nothing paid for it: ${short ? `available ${q.receipt.float.available} USDFC is under the ${need} USDFC that ${n} parts cost` : q.receipt.reason}`);
        }
      }
      if (go) await this.buyParts({ ...common, network: 'filecoin' });
    }

    if (!skip.ipfs && !prog.legs.ipfs) {
      const n = left('ipfs');
      let go = true;
      if (o.quote && n > 0) {
        const q = await this.quoteIpfs(largest, o.name);
        paid.push({ leg: 'ipfs-quote', route: q.route, price: q.price });
        const need = timesMicro(q.receipt.downstream.amountUsdc, n);
        const short = q.receipt.deliverable && n > 1 && micro(q.receipt.float.balance) < micro(need);
        this.log(`ipfs     quote ${fmtQuote(q.receipt)}${n > 1 ? `, ${n} parts need ${need} USDC` : ''}  (${Date.now() - t0} ms)`);
        if (!q.receipt.deliverable || short) {
          go = false;
          this.log(`ipfs     SKIPPED, nothing paid for it: ${short ? `float ${q.receipt.float.balance} USDC is under the ${need} USDC that ${n} parts cost` : q.receipt.reason}`);
        }
      }
      if (go) await this.buyParts({ ...common, network: 'ipfs' });
    }
  }

  /**
   * The tail every archive shares once its legs are sealed: sign the bill of
   * lading, publish it to the relay, write it to Arweave, name it on ArNS.
   * Saves the record as soon as the manifest is on Arweave and clears the
   * progress file, so a failed name leg is resumable with `lading name`.
   */
  private async attest(o: { sha: string; size: number; count: number; mime?: string; legs: LegReceipt[]; paid: PaidRow[]; t0: number; po: Pick<PutOptions, 'via' | 'undername' | 'quote' | 'skip'> }): Promise<PutResult> {
    const R = this.opts.routes;
    const { sha, paid, t0, legs } = o;
    const skip = o.po.skip ?? {};
    const doQuote = o.po.quote !== false;
    if (legs.length === 0) throw new Error('every leg was skipped; nothing to attest');
    const sk = this.nostrSecret();
    const c = await this.client();

    const content: ManifestContent = {
      sha256: sha,
      size: o.size,
      mime: o.mime,
      legs,
      ...(o.po.via ? { via: o.po.via } : {}),
      created: Math.floor(Date.now() / 1000),
    };
    let manifest = buildManifest(content, sk);

    // Publish to the relay (a plain paid write of the signed event).
    if (!skip.relay) {
      const r = await c.send(R.relay, { body: { event: manifest } });
      const price = r.fulfilled ? (r.claim?.amount ?? null) : null;
      if (!r.fulfilled) throw new Error(`relay: ${r.code} ${r.message}`);
      paid.push({ leg: 'relay', route: R.relay, price });
      this.log(`relay    ✓ event ${manifest.id}  (${Date.now() - t0} ms)`);
    }

    // The manifest itself onto Arweave, then the page over it, then named.
    let manifestTxId: string | undefined;
    let pageTxId: string | undefined;
    let pathsTxId: string | undefined;
    let nameReceipt: NameReceipt | undefined;
    if (!skip.arweave) {
      const ev = buildJobEvent({
        kind: 5094,
        params: {},
        tags: [
          ['i', Buffer.from(JSON.stringify(manifest)).toString('base64'), 'blob'],
          ['bid', '100000', 'usdc'],
          ['output', 'application/json'],
        ],
      });
      const r = await this.job<{ txId?: string }>(R.ario, ev as never);
      manifestTxId = r.receipt.txId;
      if (!manifestTxId) throw new Error('manifest write accepted without a txId');
      paid.push({ leg: 'manifest', route: r.route, price: r.price });
      this.log(`manifest ✓ ${manifestTxId}  (${Date.now() - t0} ms)`);
      this.save(sha, { manifest, manifestTxId, paid });
      this.clearProgress(sha);

      // The page a browser sees under the name, and the path manifest the name
      // points at. Both only when asked for (the door's `arns` choice): an
      // agent reads the manifest, and a name spends an undername slot.
      if (!skip.page) {
        ({ pageTxId, pathsTxId } = await this.publishPage(manifest, manifestTxId, paid, t0));
        this.save(sha, { manifest, manifestTxId, pageTxId, pathsTxId, paid });
      }

      let nameOk = !skip.name && !!pathsTxId;
      if (!skip.name && !pathsTxId) this.log('name     SKIPPED with the page; name it later with: lading name ' + sha);
      const undername = o.po.undername ?? undernameFor(sha);
      if (nameOk && doQuote) {
        const q = await this.quoteName(undername, pathsTxId);
        paid.push({ leg: 'name-quote', route: q.route, price: q.price });
        this.log(`name     quote ${fmtQuote(q.receipt)}  (${Date.now() - t0} ms)`);
        if (!q.receipt.deliverable) {
          nameOk = false;
          this.log(`name     SKIPPED, nothing paid for it; retry later with: lading name ${sha}`);
        }
      }
      if (nameOk && pathsTxId) {
        const ev2 = buildJobEvent({ kind: LEG_KIND, params: { op: 'name', txid: pathsTxId, sha256: sha, undername } });
        const r2 = await this.job<NameReceipt>(R.name, ev2 as never, 120_000);
        nameReceipt = r2.receipt;
        paid.push({ leg: 'name', route: r2.route, price: r2.price });
        this.log(`name     ✓ ${nameReceipt.url}  (${Date.now() - t0} ms)`);
        // Re-sign with the name known, so the relay copy and the file copy agree on where the manifest lives.
        manifest = buildManifest({ ...content, arns: { undername, name: nameReceipt.name, manifestTxId, pageTxId, pathsTxId } }, sk);
        if (!skip.relay) await c.send(R.relay, { body: { event: manifest } });
      }
    }

    const savedPath = this.save(sha, { manifest, manifestTxId, pageTxId, pathsTxId, name: nameReceipt, paid });
    this.clearProgress(sha);
    const total = paid.reduce((a, p) => a + (p.price ?? 0n), 0n);
    return {
      sha256: sha,
      size: o.size,
      parts: o.count,
      payerPubkey: getPublicKey(sk),
      legs,
      manifest,
      manifestTxId,
      pageTxId,
      pathsTxId,
      name: nameReceipt,
      paid,
      total,
      savedPath,
      manifestUrl: manifestTxId ? `https://${this.opts.gateway}/${manifestTxId}` : undefined,
      archivedAt: manifest.created_at,
    };
  }

  /** The progress file's paid rows as PaidRows. */
  private paidFrom(prog: Progress): PaidRow[] {
    return prog.paid.map((row) => ({ ...row, price: row.price === null ? null : BigInt(row.price) }));
  }

  /**
   * Archive: arweave leg → walrus leg → filecoin leg → sign the bill of lading
   * → publish to relay → write it to Arweave → name it on ArNS. Each leg is
   * one paid job per part; a part that fails buys nothing downstream, and the
   * parts already bought are saved so a re-run resumes, not re-buys.
   */
  async put(bytes: Uint8Array, po: PutOptions): Promise<PutResult> {
    const skip = po.skip ?? {};
    const doQuote = po.quote !== false;
    const sha = sha256(bytes);
    const name = po.name;
    const parts = splitParts(bytes, po.partBytes ?? DEFAULT_PART_BYTES);
    const n = parts.length;
    const payerPubkey = getPublicKey(this.nostrSecret());
    this.log(`${name}: ${bytes.length} bytes, sha256 ${sha}${n > 1 ? `, ${n} parts of up to ${Math.max(...parts.map((q) => q.size))} bytes` : ''}\npayer nostr pubkey ${payerPubkey}\nedge ${this.opts.edge}`);
    // Same bytes, same home: the bill of lading already exists, so hand it back
    // rather than buying every leg again. A saved put that never got its name
    // gets the name leg now, which is the one thing still owed.
    if (!po.force) {
      const prior = this.archived(sha);
      if (prior) {
        this.log(`already archived ${fmtDate(prior.archivedAt * 1000)}: manifest ${prior.manifestTxId}${prior.name ? `, named ${prior.name.name}` : ', not yet named'}; nothing re-bought (force to archive again)`);
        if (!prior.name && !skip.name) await this.nameOnly(sha, { undername: po.undername, quote: doQuote, skipRelay: skip.relay });
        return this.archived(sha)!;
      }
    }
    await this.client();
    const prog = this.loadProgress(sha);
    const paid: PaidRow[] = [];
    if (Object.keys(prog.legs).length || Object.keys(prog.parts).length) {
      paid.push(...this.paidFrom(prog));
      this.log(`resuming: ${Object.keys(prog.legs).join(',') || 'no'} legs and ${Object.entries(prog.parts).map(([k, v]) => `${k}=${v?.length ?? 0}`).join(' ') || 'no'} parts already bought`);
    }
    const t0 = Date.now();
    await this.runLegs({ sha, size: bytes.length, count: n, parts, prog, paid, t0, name, mime: po.mime, skip, quote: doQuote, walrusEpochs: po.walrusEpochs });
    const { legs, incomplete } = this.sealAll({ sha, size: bytes.length, plan: parts, prog, skip });
    const gaps = Object.entries(incomplete);
    if (gaps.length) throw new Error(`parts missing after the legs ran: ${gaps.map(([k, v]) => `${k} ${v.join(',')}`).join('; ')}`);
    return this.attest({ sha, size: bytes.length, count: n, mime: po.mime, legs, paid, t0, po });
  }

  /**
   * One slice of an object, bought on every network, into the object's
   * progress file: what the gate runs per `POST /v1/parts`. The plan is
   * recomputed from `size` and `partBytes`, so the caller's slice must be the
   * one the plan gives for `index`. Nothing is sealed or attested here.
   */
  async putPart(bytes: Uint8Array, o: PartPutOptions): Promise<PartResult> {
    const partBytes = o.partBytes ?? DEFAULT_PART_BYTES;
    const plan = planParts(o.size, partBytes);
    if (plan.length !== o.count) throw new InputError(`an object of ${o.size} bytes splits into ${plan.length} parts of ${partBytes}, not ${o.count}`);
    const p = plan[o.index];
    if (!p) throw new InputError(`part index ${o.index} is out of range for ${plan.length} parts`);
    if (p.size !== bytes.length) throw new InputError(`part ${o.index} of a ${o.size}-byte object is ${p.size} bytes, got ${bytes.length}`);
    const part: Part = { ...p, bytes, sha256: sha256(bytes) };
    if (o.partSha256 && o.partSha256 !== part.sha256) throw new InputError(`part sha256 ${o.partSha256.slice(0, 12)}… does not match the bytes (${part.sha256.slice(0, 12)}…)`);
    const prior = this.archived(o.sha256);
    if (prior) {
      this.log(`part ${o.index + 1}/${o.count}: object already archived as ${prior.manifestTxId}; nothing bought`);
      return { sha256: o.sha256, size: o.size, index: o.index, count: o.count, part: { sha256: part.sha256, size: part.size }, receipts: {}, missing: [], paid: [], total: 0n, archived: true };
    }
    this.log(`${o.name} part ${o.index + 1}/${o.count}: ${bytes.length} bytes, sha256 ${part.sha256}, object ${o.sha256}`);
    await this.client();
    const prog = this.loadProgress(o.sha256);
    const paid: PaidRow[] = [];
    const t0 = Date.now();
    await this.runLegs({ sha: o.sha256, size: o.size, count: o.count, parts: [part], prog, paid, t0, name: o.name, mime: o.mime, skip: o.skip ?? {}, quote: o.quote !== false, walrusEpochs: o.walrusEpochs });
    const receipts: PartResult['receipts'] = {};
    const missing: Network[] = [];
    for (const network of NETWORKS) {
      if (o.skip?.[network] || (network === 'arweave' && o.skip?.arweaveObject)) continue;
      const r = prog.parts[network]?.find((x) => x.index === o.index);
      if (r) receipts[network] = r;
      else missing.push(network);
    }
    return { sha256: o.sha256, size: o.size, index: o.index, count: o.count, part: { sha256: part.sha256, size: part.size }, receipts, missing, paid, total: paid.reduce((a, x) => a + (x.price ?? 0n), 0n) };
  }

  /**
   * Seal and attest an object whose parts were bought with putPart. Every
   * network that bought anything must hold every part, or the missing indexes
   * are reported (re-send those parts); `skip` drops a network on purpose.
   */
  async finish(o: FinishOptions): Promise<PutResult> {
    const sha = o.sha256;
    if (!o.force) {
      const prior = this.archived(sha);
      if (prior) {
        this.log(`already archived ${fmtDate(prior.archivedAt * 1000)}: manifest ${prior.manifestTxId}; nothing re-bought`);
        if (!prior.name && !o.skip?.name) await this.nameOnly(sha, { undername: o.undername, quote: o.quote, skipRelay: o.skip?.relay });
        return this.archived(sha)!;
      }
    }
    const partBytes = o.partBytes ?? DEFAULT_PART_BYTES;
    const plan = planParts(o.size, partBytes);
    if (plan.length !== o.count) throw new InputError(`an object of ${o.size} bytes splits into ${plan.length} parts of ${partBytes}, not ${o.count}`);
    const prog = this.loadProgress(sha);
    if (!Object.keys(prog.legs).length && !Object.values(prog.parts).some((v) => v?.length)) throw new InputError(`no parts bought for ${sha}; send them to /v1/parts first`);
    const skip = o.skip ?? {};
    const { legs, incomplete } = this.sealAll({ sha, size: o.size, plan, prog, skip });
    if (!skip.arweave && !skip.arweaveObject && !legs.some((l) => l.network === 'arweave') && !incomplete.arweave) incomplete.arweave = plan.map((p) => p.index);
    const gaps = Object.entries(incomplete);
    if (gaps.length) throw new PartsMissingError(sha, incomplete);
    await this.client();
    const paid = this.paidFrom(prog);
    const t0 = Date.now();
    this.log(`${o.name}: finishing ${o.size} bytes in ${o.count} parts, legs ${legs.map((l) => l.network).join('+')}`);
    return this.attest({ sha, size: o.size, count: o.count, mime: o.mime, legs, paid, t0, po: { via: o.via, undername: o.undername, quote: o.quote, skip } });
  }

  /** What the progress file holds for an object: which indexes each network has, and which legs are sealed. */
  partsStatus(sha: string): PartsStatus {
    const prior = this.archived(sha);
    const prog = this.loadProgress(sha);
    const networks: PartsStatus['networks'] = {};
    for (const network of NETWORKS) {
      const sealed = prog.legs[network];
      const idx = sealed ? (sealed.parts ? sealed.parts.map((p) => p.index) : [0]) : (prog.parts[network] ?? []).map((r) => r.index).sort((a, b) => a - b);
      if (idx.length || sealed) networks[network] = { indexes: idx, sealed: !!sealed };
    }
    const paidUnits = prog.paid.reduce((a, p) => a + BigInt(p.price ?? '0'), 0n);
    return { sha256: sha, archived: !!prior, manifestTxId: prior?.manifestTxId, name: prior?.name?.name, networks, paidUnits: paidUnits.toString() };
  }

  /** True when this slice is already bought on every network in `networks` (the caller's choice; arweave and walrus by default): the gate answers such a part at the floor. */
  partKnown(sha: string, index: number, partSha: string, networks: readonly Network[] = ['arweave', 'walrus']): boolean {
    if (this.archived(sha)) return true;
    const prog = this.loadProgress(sha);
    return networks.every((n) => prog.legs[n] !== undefined || prog.parts[n]?.some((r) => r.index === index && r.sha256 === partSha));
  }

  /** Drop progress files older than `maxAgeMs` (objects whose parts were bought but never finished). Returns what was removed. */
  sweepProgress(maxAgeMs: number): string[] {
    const dir = join(this.opts.home, 'progress');
    if (!existsSync(dir)) return [];
    const gone: string[] = [];
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p);
        gone.push(f);
      }
    }
    return gone;
  }

  /**
   * The bill of lading page onto Arweave, then the path manifest that serves
   * it at `/` and the signed JSON at `/manifest.json`. Two small writes on the
   * Arweave route; the name then points at the path manifest. The page is
   * rendered from the manifest as signed before the name leg, which is exactly
   * what `manifest.json` holds.
   */
  private async publishPage(manifest: NostrEvent, manifestTxId: string, paid: PaidRow[], t0 = Date.now()): Promise<{ pageTxId: string; pathsTxId: string }> {
    const R = this.opts.routes;
    const html = renderPage(manifest, { readUrls: (n, id, proof) => this.readUrlsFor(n, id, proof), gateway: this.opts.gateway, gateUrl: this.opts.gateUrl, repoUrl: REPO_URL });
    const write = async (leg: string, body: string, contentType: string) => {
      const ev = buildJobEvent({ kind: 5094, params: {}, tags: [['i', Buffer.from(body).toString('base64'), 'blob'], ['bid', '100000', 'usdc'], ['output', contentType]] });
      const r = await this.job<{ txId?: string }>(R.ario, ev as never);
      if (!r.receipt.txId) throw new Error(`${leg} write accepted without a txId`);
      paid.push({ leg, route: r.route, price: r.price });
      this.log(`${leg.padEnd(8)} ✓ ${r.receipt.txId}  (${Buffer.byteLength(body)} B, ${Date.now() - t0} ms)`);
      return r.receipt.txId;
    };
    const pageTxId = await write('page', html, PAGE_CONTENT_TYPE);
    const pathsTxId = await write('paths', pathManifest(pageTxId, manifestTxId), PATHS_CONTENT_TYPE);
    return { pageTxId, pathsTxId };
  }

  /** A saved put's page and path manifest, publishing them first when the record predates 0.13 or died before them. */
  private async ensurePage(sha: string, saved: SavedPut, paid: PaidRow[], force = false): Promise<{ pageTxId: string; pathsTxId: string }> {
    if (!saved.manifestTxId) throw new Error('saved manifest has no Arweave txId; run put again');
    if (!force && saved.pageTxId && saved.pathsTxId) return { pageTxId: saved.pageTxId, pathsTxId: saved.pathsTxId };
    // A named record holds the manifest as re-signed with the name; the page
    // must carry the very event manifest.json holds, so read that back.
    let onArweave = saved.manifest;
    if (saved.manifest.tags.some((t) => t[0] === 'arns')) {
      const r = await readFirst(arweaveReadUrls(saved.manifestTxId, this.readGateways()));
      if (!r.bytes) throw new Error(`cannot read the manifest ${saved.manifestTxId} back to render its page: ${r.tried.join(', ')}`);
      onArweave = JSON.parse(new TextDecoder().decode(r.bytes)) as NostrEvent;
      if (parseManifest(onArweave).sha256 !== sha) throw new Error(`manifest ${saved.manifestTxId} is not for ${sha}`);
    }
    const ids = await this.publishPage(onArweave, saved.manifestTxId, paid);
    saved.pageTxId = ids.pageTxId;
    saved.pathsTxId = ids.pathsTxId;
    // The record in memory carries the page rows too, so a name bought next in the same call lists them on the bill.
    saved.paid = [...saved.paid, ...paid.map((p) => ({ ...p, price: p.price?.toString() }))] as SavedPut['paid'];
    writeFileSync(this.manifestPath(sha), JSON.stringify(saved, null, 2));
    return ids;
  }

  /** Point the undername at a txid, re-sign the manifest with the name known, publish that to the relay, and record it all. */
  private async nameAt(sha: string, saved: SavedPut, ids: { pageTxId: string; pathsTxId: string }, o: { undername?: string; quote?: boolean; skipRelay?: boolean }): Promise<{ name: NameReceipt; manifest: NostrEvent }> {
    const R = this.opts.routes;
    const content = parseManifest(saved.manifest);
    const sk = this.nostrSecret();
    const c = await this.client();
    const undername = o.undername ?? undernameFor(sha);
    if (o.quote !== false) {
      const q = await this.quoteName(undername, ids.pathsTxId);
      this.log(`name     quote ${fmtQuote(q.receipt)}`);
      if (!q.receipt.deliverable) throw new Error(`name leg would not go through; nothing paid for it. (${q.receipt.reason})`);
    }
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'name', txid: ids.pathsTxId, sha256: sha, undername } });
    const r = await this.job<NameReceipt>(R.name, ev as never, 120_000);
    this.log(`name     ✓ ${r.receipt.url}`);
    const manifest = buildManifest({ ...content, arns: { undername, name: r.receipt.name, manifestTxId: saved.manifestTxId as string, ...ids } }, sk);
    if (!o.skipRelay) {
      const rr = await c.send(R.relay, { body: { event: manifest } });
      this.log(rr.fulfilled ? `relay    ✓ re-signed manifest ${manifest.id}` : `relay    ✗ ${rr.code} ${rr.message}`);
    }
    writeFileSync(this.manifestPath(sha), JSON.stringify({ ...saved, ...ids, manifest, name: r.receipt, paid: [...saved.paid, { leg: 'name', route: r.route, price: r.price?.toString() }] }, null, 2));
    return { name: r.receipt, manifest };
  }

  /** Retry the ArNS name leg for a saved manifest whose earlier name job failed, without re-uploading the object. */
  async nameOnly(sha: string, o: { undername?: string; quote?: boolean; skipRelay?: boolean } = {}): Promise<{ name: NameReceipt; already: boolean; manifest: NostrEvent }> {
    const hit = this.savedPut(sha);
    if (!hit) throw new Error(`no saved manifest for ${sha} at ${this.manifestPath(sha)}`);
    const { saved } = hit;
    if (saved.name) {
      this.log(`already named: ${saved.name.url}`);
      return { name: saved.name as NameReceipt, already: true, manifest: saved.manifest };
    }
    const ids = await this.ensurePage(sha, saved, []);
    const r = await this.nameAt(sha, saved, ids, o);
    return { ...r, already: false };
  }

  /**
   * Give a saved put its page: publish the page and path manifest when the
   * record has none (a name from before 0.13 points at the bare JSON) and
   * point the name at them. A record that already has both and is named at
   * them is left alone. `all` runs it over every saved put.
   */
  async pageOnly(sha: string, o: { quote?: boolean; skipRelay?: boolean; force?: boolean } = {}): Promise<{ pageTxId: string; pathsTxId: string; name?: NameReceipt; already: boolean }> {
    const hit = this.savedPut(sha);
    if (!hit) throw new Error(`no saved manifest for ${sha} at ${this.manifestPath(sha)}`);
    const { saved } = hit;
    const had = !!(saved.pageTxId && saved.pathsTxId);
    const named = saved.name as NameReceipt | undefined;
    if (!o.force && had && named && named.manifestTxId === saved.pathsTxId) {
      this.log(`already paged: ${named.url}`);
      return { pageTxId: saved.pageTxId as string, pathsTxId: saved.pathsTxId as string, name: named, already: true };
    }
    // `force` renders the page again (a newer page template) and points the name at the new one.
    const ids = await this.ensurePage(sha, saved, [], o.force);
    const r = await this.nameAt(sha, saved, ids, { undername: named?.undername, ...o });
    return { ...ids, name: r.name, already: false };
  }

  // ---- reading back ----

  /** A manifest by ArNS name, Arweave txid, URL, or path to a saved file. */
  async fetchManifest(ref: string): Promise<NostrEvent> {
    return (await this.fetchManifestFrom(ref)).event;
  }

  /** The manifest plus where it was read from ("local file", or "ardrive.net (permagate.io 502)"). */
  async fetchManifestFrom(ref: string): Promise<{ event: NostrEvent; source: string }> {
    if (existsSync(ref)) {
      const j = JSON.parse(readFileSync(ref, 'utf8'));
      return { event: (j.manifest ?? j) as NostrEvent, source: 'local file' };
    }
    // A name serves the page at `/` and the JSON at `/manifest.json` (0.13+),
    // or the bare JSON at `/` (older); ask for the JSON first, then take
    // whatever the root serves, page or JSON.
    const urls = ARWEAVE_TXID_RE.test(ref)
      ? arweaveReadUrls(ref, this.readGateways())
      : ref.startsWith('http')
        ? [ref]
        : [...arnsReadUrls(ref, this.arnsGateways()).map((u) => `${u}manifest.json`), ...arnsReadUrls(ref, this.arnsGateways())];
    const r = await readFirst(urls);
    if (!r.bytes) throw new Error(`${urls[0]}: ${r.tried.join(', ')}`);
    const host = r.url.replace(/^https?:\/\//, '').split('/')[0];
    const source = r.tried.length > 1 ? `${host} (${r.tried.slice(0, -1).join(', ')})` : host;
    return { event: manifestFromPage(new TextDecoder().decode(r.bytes)), source };
  }

  /** The gateways a raw txid may be read from, the ArNS gateway first. */
  readGateways(): string[] {
    return readGateways(this.opts.gateway, this.opts.readGateways.join(','));
  }

  /** The gateways an ArNS name may be resolved from, the configured one first. */
  arnsGateways(): string[] {
    return readGateways(this.opts.gateway, this.opts.arnsGateways.join(','), DEFAULT_ARNS_GATEWAYS);
  }

  /** Every URL a leg's bytes may be read from: several for Arweave and IPFS, one otherwise. */
  readUrlsFor(network: string, id: string, proof?: Record<string, string | number | undefined>): string[] {
    if (network === 'arweave') return arweaveReadUrls(id, this.readGateways());
    if (network === 'ipfs') return ipfsReadUrls(id, this.opts.ipfsGateways);
    const u = this.readUrlFor(network, id, proof);
    return u === undefined ? [] : [u];
  }

  /** Where a network serves one id from, given what the receipt recorded. */
  readUrlFor(network: string, id: string, proof?: Record<string, string | number | undefined>): string | undefined {
    if (network === 'arweave') return `https://${this.opts.gateway}/${id}`;
    if (network === 'walrus') return String(proof?.ipfsUrl ?? `${this.opts.walrusAggregator}/v1/blobs/${id}`);
    if (network === 'ipfs') return ipfsReadUrls(id, this.opts.ipfsGateways)[0];
    return proof?.readUrl === undefined ? undefined : String(proof.readUrl);
  }

  /** Re-fetch every leg named in a manifest and compare sha256. */
  async verify(ref: string): Promise<VerifyResult> {
    const { event, source } = await this.fetchManifestFrom(ref);
    const m = parseManifest(event);
    const rows: VerifyLegRow[] = [];
    let ok = true;
    for (const leg of m.legs) {
      if (!leg.parts) {
        const urls = this.readUrlsFor(leg.network, leg.id, leg.proof);
        if (urls.length === 0) {
          rows.push({ label: leg.network, id: leg.id, ok: false, detail: 'no read url' });
          ok = false;
          continue;
        }
        const r = await readFirst(urls);
        const got = r.bytes ? sha256(r.bytes) : undefined;
        const match = got === m.sha256;
        ok &&= match;
        rows.push({ label: leg.network, id: leg.id, ok: match, detail: match ? `sha256 match${viaNote(r)}` : `${r.tried.join(', ')}${got ? ` got ${got.slice(0, 12)}` : ''}` });
        continue;
      }
      // A chunked leg: every part must come back with its own sha256, and the
      // reassembled object must hash to the manifest's.
      const fetched: Array<{ index: number; sha256: string; bytes: Uint8Array }> = [];
      let legOk = true;
      for (const part of leg.parts) {
        const urls = this.readUrlsFor(leg.network, part.id, part.proof);
        const r = urls.length ? await readFirst(urls) : { status: 0, url: '', tried: [] as string[] };
        const got = r.bytes ? sha256(r.bytes) : undefined;
        const match = got === part.sha256;
        legOk &&= match;
        rows.push({ label: `${leg.network}#${part.index + 1}`, id: part.id, ok: match, detail: match ? `part sha256 match${viaNote(r)}` : `${urls.length ? r.tried.join(', ') : 'no read url'}${got ? ` got ${got.slice(0, 12)}` : ''}` });
        if (match && r.bytes) fetched.push({ index: part.index, sha256: part.sha256, bytes: r.bytes });
      }
      let whole: string | undefined;
      let assembly = '';
      if (legOk && fetched.length === leg.parts.length) {
        try {
          whole = sha256(assembleParts(fetched));
        } catch (e) {
          assembly = `assembly failed: ${(e as Error).message}`;
        }
      }
      const match = whole === m.sha256;
      ok &&= match;
      rows.push({ label: leg.network, id: `${leg.parts.length} parts reassembled`, ok: match, detail: match ? 'sha256 match' : assembly || (whole ? `got ${whole.slice(0, 12)}` : 'parts missing') });
    }
    return { pubkey: event.pubkey, sha256: m.sha256, size: m.size, legs: m.legs.length, rows, ok, manifest: m, source };
  }

  // ---- renewals ----

  /** What the payer holds on Walrus and when each record runs out. Free: reads local files, and with `live` Lighthouse's public price endpoint. */
  async renewals(o: { within?: number; live?: boolean } = {}): Promise<{ rows: RenewalRow[]; due: RenewalRow[]; within: number }> {
    const within = o.within ?? 60;
    const rows = this.savedPuts().flatMap(({ saved }) => walrusRecords(saved));
    if (o.live) {
      for (const r of rows) {
        if (r.provider === 'native') {
          // The chain is the ledger for a native record: the extend quote door reads the object and the epoch timing (1,000 units per row).
          const q = await this.quoteWalrusExtend(r.handle);
          if (!q.receipt.found) {
            r.daysLeft = Number.NaN;
            continue;
          }
          if (q.receipt.currentExpiresAt !== undefined) {
            r.expiresAt = q.receipt.currentExpiresAt;
            r.daysLeft = daysLeft(q.receipt.currentExpiresAt);
          }
          if (q.receipt.endEpoch !== undefined) r.endEpoch = q.receipt.endEpoch;
          continue;
        }
        const res = await fetch(`${this.opts.lighthouseX402}/api/renew/price?id=${encodeURIComponent(r.lighthouseId)}`);
        if (res.status === 404) {
          r.daysLeft = Number.NaN;
          continue;
        }
        if (!res.ok) throw new Error(`lighthouse renew price for ${r.lighthouseId}: ${res.status}`);
        const j = (await res.json()) as { currentExpiresAt?: number };
        if (typeof j.currentExpiresAt === 'number') {
          r.expiresAt = j.currentExpiresAt;
          r.daysLeft = daysLeft(j.currentExpiresAt);
        }
      }
    }
    rows.sort((a, b) => a.expiresAt - b.expiresAt);
    const due = dueWithin(rows.filter((r) => !Number.isNaN(r.daysLeft)), within);
    return { rows, due, within };
  }

  /**
   * Buy one more year on Walrus. `ref` is a saved put's sha256 (every record of
   * that object, all parts) or one Lighthouse record id. Each record is quoted
   * first and only paid when its quote says deliverable; the saved file records
   * the new paid-through date so `lading renewals` reads it back.
   */
  async renew(ref: string, o: { quote?: boolean; epochs?: number } = {}): Promise<RenewResult> {
    const R = this.opts.routes;
    const isSha = /^[0-9a-f]{64}$/.test(ref);
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const isObject = /^0x[0-9a-fA-F]{64}$/.test(ref);
    if (!isSha && !isId && !isObject) throw new Error('renew wants a saved put sha256, a Lighthouse record id, or a Sui blob object id');
    const puts = this.savedPuts();
    type Target = { provider: 'lighthouse' | 'native'; handle: string; blobId?: string; put?: { path: string; saved: SavedPut }; label: string };
    const targets: Target[] = [];
    if (isSha) {
      const put = puts.find((p) => p.sha === ref);
      if (!put) throw new Error(`no saved manifest for ${ref} under ${join(this.opts.home, 'manifests')}`);
      for (const r of walrusRecords(put.saved)) targets.push({ provider: r.provider, handle: r.handle, blobId: r.blobId, put, label: `walrus${partLabel(r)}` });
      if (targets.length === 0) throw new Error(`the saved put ${ref.slice(0, 12)} has no walrus records`);
    } else {
      const put = puts.find((p) => walrusRecords(p.saved).some((r) => r.handle === ref));
      targets.push({ provider: isObject ? 'native' : 'lighthouse', handle: ref, put, label: 'walrus' });
    }
    const t0 = Date.now();
    let total = 0n;
    let bought = 0;
    const rows: RenewResult['rows'] = [];
    for (const t of targets) {
      const tag = t.label.padEnd(9);
      const row = (extra: Partial<RenewResult['rows'][number]>): RenewResult['rows'][number] => ({ label: t.label, provider: t.provider, handle: t.handle, lighthouseId: t.provider === 'lighthouse' ? t.handle : '', blobId: t.blobId, recorded: false, ...extra });
      if (t.provider === 'native') {
        // A native record: more epochs on the Sui blob object, through the extend doors.
        if (o.quote !== false) {
          const q = await this.quoteWalrusExtend(t.handle, o.epochs);
          total += q.price ?? 0n;
          this.log(`${tag} quote ${fmtExtendQuote(q.receipt)}  (${Date.now() - t0} ms)`);
          if (!q.receipt.deliverable) {
            this.log(`${tag} SKIPPED, nothing paid for it`);
            rows.push(row({ skipped: q.receipt.reason ?? 'not deliverable' }));
            continue;
          }
        }
        const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus-extend', objectId: t.handle, ...(o.epochs ? { epochs: String(o.epochs) } : {}) } });
        const r = await this.job<WalrusExtendReceipt>(R.walrusExtend, ev as never, 180_000);
        total += r.price ?? 0n;
        bought++;
        const rec: SavedRenewal = {
          network: 'walrus',
          objectId: t.handle,
          blobId: r.receipt.blobId,
          previousExpiresAt: r.receipt.previousExpiresAt,
          expiresAt: r.receipt.expiresAt,
          previousEndEpoch: r.receipt.previousEndEpoch,
          endEpoch: r.receipt.endEpoch,
          route: r.route,
          price: r.price?.toString() ?? null,
          digest: r.receipt.proof.digest,
          at: r.receipt.at,
        };
        if (t.put) {
          t.put.saved.renewals = [...(t.put.saved.renewals ?? []), rec];
          writeFileSync(t.put.path, JSON.stringify(t.put.saved, null, 2));
        }
        this.log(`${tag} ✓ ${r.receipt.blobId}  epoch ${r.receipt.previousEndEpoch} -> ${r.receipt.endEpoch} (${fmtDate(r.receipt.previousExpiresAt)} -> ${fmtDate(r.receipt.expiresAt)})  ${r.receipt.proof.amountWal} WAL  sui tx ${rec.digest}${t.put ? '' : '  (no saved put; not recorded locally)'}  (${Date.now() - t0} ms)`);
        rows.push(row({ blobId: r.receipt.blobId, previousExpiresAt: r.receipt.previousExpiresAt, expiresAt: r.receipt.expiresAt, previousEndEpoch: r.receipt.previousEndEpoch, endEpoch: r.receipt.endEpoch, digest: rec.digest, recorded: !!t.put }));
        continue;
      }
      if (o.quote !== false) {
        const q = await this.quoteWalrusRenew(t.handle);
        total += q.price ?? 0n;
        this.log(`${tag} quote ${fmtRenewQuote(q.receipt)}  (${Date.now() - t0} ms)`);
        if (!q.receipt.deliverable) {
          this.log(`${tag} SKIPPED, nothing paid for it`);
          rows.push(row({ skipped: q.receipt.reason ?? 'not deliverable' }));
          continue;
        }
      }
      const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus-renew', lighthouseId: t.handle } });
      const r = await this.job<WalrusRenewReceipt>(R.walrusRenew, ev as never, 180_000);
      total += r.price ?? 0n;
      bought++;
      const rec: SavedRenewal = {
        network: 'walrus',
        lighthouseId: t.handle,
        blobId: r.receipt.blobId,
        previousExpiresAt: r.receipt.previousExpiresAt,
        expiresAt: r.receipt.expiresAt,
        route: r.route,
        price: r.price?.toString() ?? null,
        ...(r.receipt.proof.baseTx ? { baseTx: String(r.receipt.proof.baseTx) } : {}),
        at: r.receipt.at,
      };
      if (t.put) {
        t.put.saved.renewals = [...(t.put.saved.renewals ?? []), rec];
        writeFileSync(t.put.path, JSON.stringify(t.put.saved, null, 2));
      }
      this.log(`${tag} ✓ ${r.receipt.blobId}  ${fmtDate(r.receipt.previousExpiresAt)} -> ${fmtDate(r.receipt.expiresAt)}${rec.baseTx ? `  base tx ${rec.baseTx}` : ''}${t.put ? '' : '  (no saved put; not recorded locally)'}  (${Date.now() - t0} ms)`);
      rows.push(row({ blobId: r.receipt.blobId, previousExpiresAt: r.receipt.previousExpiresAt, expiresAt: r.receipt.expiresAt, baseTx: rec.baseTx, recorded: !!t.put }));
    }
    return { rows, bought, targets: targets.length, total };
  }

  /** What the node serves: every route Lading uses and its price. */
  async describe(): Promise<Array<{ key: string; route: string; price: bigint | null }>> {
    const c = await this.client();
    const out: Array<{ key: string; route: string; price: bigint | null }> = [];
    for (const [key, route] of Object.entries(this.opts.routes)) {
      const p = await c.price(route).catch(() => null);
      out.push({ key, route, price: p === null ? null : BigInt(p as never) });
    }
    return out;
  }

  /** The whole bill before paying it: route prices from the edge, deliverability from the three quote doors. Costs three quotes. */
  async quote(bytes: Uint8Array, o: { name: string; undername?: string; partBytes?: number; networks?: readonly Network[]; walrusEpochs?: number; arns?: boolean }): Promise<QuoteResult> {
    const R = this.opts.routes;
    const nets = o.networks ?? NETWORKS;
    const sha = sha256(bytes);
    const undername = o.undername ?? undernameFor(sha);
    const parts = planParts(bytes.length, o.partBytes ?? DEFAULT_PART_BYTES);
    const n = parts.length;
    const largest = Math.max(...parts.map((q) => q.size));
    const est = await this.estimate(bytes.length, o.partBytes ?? DEFAULT_PART_BYTES, nets, !!o.arns);
    const row = (leg: string) => est.rows.find((r) => r.leg === leg)!;
    const rows: QuoteRow[] = [];
    let quotesPaid = 0n;
    if (nets.includes('arweave')) rows.push(row('arweave'));
    if (nets.includes('walrus')) {
      const wq = await this.quoteWalrus(largest, o.name, o.walrusEpochs);
      quotesPaid += wq.price ?? 0n;
      const { asset: wAsset, need: wNeed, short: wShort } = walrusNeed(wq.receipt, n);
      const wGo = wq.receipt.deliverable && !wShort;
      rows.push({ leg: 'walrus-quote', route: wq.route, price: wq.price, note: fmtQuote(wq.receipt) + (n > 1 ? `, ${n} parts need ${wNeed} ${wAsset}${wShort ? ' (SHORT)' : ''}` : '') });
      rows.push({ leg: 'walrus', route: R.walrus, price: wGo ? row('walrus').price : 0n, note: wGo ? row('walrus').note : 'would not be paid' });
    }
    if (nets.includes('filecoin')) {
      const fq = await this.quoteFilecoin(largest, o.name);
      quotesPaid += fq.price ?? 0n;
      const fNeed = timesMicro(fq.receipt.downstream.addPieceFeeUsdfc, n);
      const fShort = fq.receipt.deliverable && n > 1 && micro(fq.receipt.float.available) < micro(fNeed);
      const fGo = fq.receipt.deliverable && !fShort;
      rows.push({ leg: 'filecoin-quote', route: fq.route, price: fq.price, note: fmtQuote(fq.receipt) + (n > 1 ? `, ${n} parts need ${fNeed} USDFC in fees${fShort ? ' (SHORT)' : ''}` : '') });
      rows.push({ leg: 'filecoin', route: R.filecoin, price: fGo ? row('filecoin').price : 0n, note: fGo ? row('filecoin').note : 'would be skipped' });
    }
    if (nets.includes('ipfs')) {
      const iq = await this.quoteIpfs(largest, o.name);
      quotesPaid += iq.price ?? 0n;
      const iNeed = timesMicro(iq.receipt.downstream.amountUsdc, n);
      const iShort = iq.receipt.deliverable && n > 1 && micro(iq.receipt.float.balance) < micro(iNeed);
      const iGo = iq.receipt.deliverable && !iShort;
      rows.push({ leg: 'ipfs-quote', route: iq.route, price: iq.price, note: fmtQuote(iq.receipt) + (n > 1 ? `, ${n} parts need ${iNeed} USDC${iShort ? ' (SHORT)' : ''}` : '') });
      rows.push({ leg: 'ipfs', route: R.ipfs, price: iGo ? row('ipfs').price : 0n, note: iGo ? row('ipfs').note : 'would be skipped' });
    }
    rows.push(row('relay'));
    rows.push(row('manifest'));
    if (o.arns) {
      rows.push(row('page'));
      rows.push(row('paths'));
      const nq = await this.quoteName(undername);
      quotesPaid += nq.price ?? 0n;
      rows.push({ leg: 'name-quote', route: nq.route, price: nq.price, note: fmtQuote(nq.receipt) });
      rows.push({ leg: 'name', route: R.name, price: nq.receipt.deliverable ? row('name').price : 0n, note: nq.receipt.deliverable ? 'flat' : 'would be skipped' });
    }
    const total = rows.reduce((a, r) => a + (r.price ?? 0n), 0n);
    return { sha256: sha, size: bytes.length, parts: n, largestPart: largest, rows, total, quotesPaid };
  }
}

export const partLabel = (r: RenewalRow) => (r.part < 0 ? '' : `#${r.part + 1}/${r.parts}`);

export const fmtRenewQuote = (q: WalrusRenewQuote) =>
  `${q.deliverable ? 'deliverable' : 'NOT deliverable'}, downstream ${q.downstream.amountUsdc} USDC, float ${q.float.balance} USDC on Base` +
  (q.currentExpiresAt ? `, paid through ${fmtDate(q.currentExpiresAt)} (${q.daysLeft} days)` : '') +
  (q.known ? '' : ', record not in the broker ledger') +
  (q.reason ? `: ${q.reason}` : '');

export const fmtQuote = (q: WalrusQuote | FilecoinQuote | IpfsQuote | NameQuote) => {
  const head = q.deliverable ? 'deliverable' : 'NOT deliverable';
  const tail = q.reason ? `: ${q.reason}` : '';
  if (q.op === 'walrus') {
    const asset = q.downstream.asset ?? 'USDC';
    const amount = q.downstream.amount ?? q.downstream.amountUsdc;
    const chain = q.float.chain === 'sui' ? 'Sui' : 'Base';
    return `${head} via ${q.downstream.provider}, downstream ${amount} ${asset}${q.downstream.epochs ? ` for ${q.downstream.epochs} epochs` : ''}, float ${q.float.balance} ${q.float.asset} on ${chain}${q.float.sui ? ` (+ ${q.float.sui} SUI)` : ''}${tail}${q.alternative ? ` [native: ${q.alternative.reason}]` : ''}`;
  }
  if (q.op === 'ipfs') return `${head}, downstream ${q.downstream.amountUsdc} USDC, float ${q.float.balance} USDC on Base${tail}`;
  if (q.op === 'filecoin') return `${head}, add-piece fee ${q.downstream.addPieceFeeUsdfc} USDFC for ${q.copies} copies, float ${q.float.available} USDFC, runway ${/^\d+$/.test(q.float.runwayDays) ? `${q.float.runwayDays}d` : q.float.runwayDays}${tail}`;
  return `${head}, ${q.name}, float ${(Number(q.float.lamports) / 1e9).toFixed(4)} SOL${tail}`;
};

export const fmtExtendQuote = (q: WalrusExtendQuote) =>
  `${q.deliverable ? 'deliverable' : `NOT deliverable (${q.reason})`}, ${q.found ? `end epoch ${q.endEpoch} -> ${q.newEndEpoch} (${q.currentExpiresAt ? `${fmtDate(q.currentExpiresAt)}, ${q.daysLeft} days left` : 'date unknown'})` : 'object not found'}, downstream ${q.downstream.amount} WAL for ${q.epochs} epochs, float ${q.float.balance} WAL (+ ${q.float.sui} SUI)${q.known ? '' : ', NOT owned by the broker'}`;
