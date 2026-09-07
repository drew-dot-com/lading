#!/usr/bin/env node
/**
 * The Lading client: the party that pays, and the one that composes legs.
 *
 *   lading put <file>       archive: arweave leg → walrus leg → filecoin leg →
 *                           sign the bill of lading → publish to relay → write
 *                           it to Arweave → name it on ArNS. Each leg is one paid job per
 *                           part (an object over one packet travels as parts, see
 *                           parts.ts); a part that fails buys nothing downstream, and the
 *                           parts already bought are saved so a re-run resumes, not re-buys.
 *   lading verify <ref>     re-fetch every leg named in a manifest and compare
 *                           sha256. <ref> is an ArNS name, a manifest txId, or
 *                           a path to a saved manifest.
 *   lading name <sha>       retry the ArNS name leg for a saved manifest whose
 *                           earlier name job failed, without re-uploading.
 *   lading quote <file>     the full bill before paying it: every route's price
 *                           plus each leg's quote (deliverable right now, and
 *                           the downstream cost the broker will carry).
 *   lading renewals         every Walrus record in the saved manifests with its
 *                           paid-through date; --within <days> (default 60) marks
 *                           what is due; --live asks Lighthouse for today's date.
 *   lading renew <sha|id>   buy one more year on Walrus for a saved put's records
 *                           (or one Lighthouse record id) through the renew door,
 *                           quote first; the saved file records the new date.
 *   lading describe         what the node serves.
 *
 * Coordination lives here, not in the handler: that is the pattern every TOON
 * app follows (a handler is a leaf), and it keeps the broker unable to spend
 * on the payer's behalf beyond the one leg it was paid for.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ToonClient, buildJobEvent, sendJob, chargeFor } from '@toon-protocol/client';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { LEG_KIND, type FilecoinReceipt, type LegReceipt, type NameReceipt, type PartReceipt, type WalrusReceipt, type WalrusRenewReceipt } from './kinds.js';
import { assembleParts, DEFAULT_PART_BYTES, partName, planParts, splitParts, type Part } from './parts.js';
import type { FilecoinQuote, NameQuote, WalrusQuote, WalrusRenewQuote } from './quote.js';
import { dueWithin, fmtDate, walrusRecords, type RenewalRow, type SavedPut, type SavedRenewal } from './renewals.js';
import { daysLeft } from './ledger.js';
import { buildManifest, parseManifest, type ManifestContent } from './manifest.js';
import { undernameFor } from './arns.js';

const env = (k: string, d: string) => process.env[k] ?? d;
const EDGE = env('TOON_EDGE', 'https://connector.167-233-221-236.sslip.io');
const ROUTES = {
  ario: env('LADING_ROUTE_ARIO', 'g.drew.ario'),
  walrus: env('LADING_ROUTE_WALRUS', 'g.drew.lading.walrus'),
  walrusQuote: env('LADING_ROUTE_WALRUS_QUOTE', 'g.drew.lading.walrus.quote'),
  walrusRenew: env('LADING_ROUTE_WALRUS_RENEW', 'g.drew.lading.walrus.renew'),
  walrusRenewQuote: env('LADING_ROUTE_WALRUS_RENEW_QUOTE', 'g.drew.lading.walrus.renew.quote'),
  filecoin: env('LADING_ROUTE_FILECOIN', 'g.drew.lading.filecoin'),
  filecoinQuote: env('LADING_ROUTE_FILECOIN_QUOTE', 'g.drew.lading.filecoin.quote'),
  name: env('LADING_ROUTE_NAME', 'g.drew.lading.name'),
  nameQuote: env('LADING_ROUTE_NAME_QUOTE', 'g.drew.lading.name.quote'),
  relay: env('LADING_ROUTE_RELAY', 'g.drew.relay'),
};
const GATEWAY = env('LADING_ARNS_GATEWAY', 'permagate.io');
const LIGHTHOUSE_X402 = env('LIGHTHOUSE_X402_URL', 'https://x402-walrus.lighthouse.storage');
const AGGREGATOR = env('WALRUS_AGGREGATOR_URL', 'https://aggregator.walrus-mainnet.walrus.space');
const HOME = join(homedir(), '.lading');

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const partBytes = () => {
  const n = Number(opt('part-bytes') ?? DEFAULT_PART_BYTES);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--part-bytes must be a positive integer, got ${opt('part-bytes')}`);
  return n;
};
/** USDC/USDFC decimal strings compared in micro-units, as quote.ts does. */
const micro = (v: string): bigint => {
  const [i, f = ''] = v.split('.');
  return BigInt(i || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const timesMicro = (v: string, n: number) => (Number(micro(v) * BigInt(n)) / 1e6).toFixed(6);

function nostrSecret(): Uint8Array {
  const hex = process.env.LADING_NOSTR_KEY;
  if (hex) return Uint8Array.from(Buffer.from(hex, 'hex'));
  mkdirSync(HOME, { recursive: true });
  const p = join(HOME, 'nostr.key');
  if (!existsSync(p)) {
    writeFileSync(p, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    console.log(`new payer identity written to ${p}`);
  }
  return Uint8Array.from(Buffer.from(readFileSync(p, 'utf8').trim(), 'hex'));
}

async function client() {
  const keypair = env('SOLANA_KEYPAIR', join(homedir(), '.config/solana/id.json'));
  mkdirSync(HOME, { recursive: true });
  return ToonClient.create({
    connector: EDGE,
    solanaSecretKey: Uint8Array.from(JSON.parse(readFileSync(keypair, 'utf8')) as number[]),
    evmPrivateKey: ('0x' + randomBytes(32).toString('hex')) as `0x${string}`,
    chain: 'solana',
    rpcUrl: env('SOLANA_RPC', 'https://api.mainnet-beta.solana.com'),
    transport: 'http',
    channelStore: env('LADING_CHANNEL_STORE', join(HOME, 'channel-store.json')),
    autoOpenChannel: true,
    // Collateral locked when a channel has to be opened (base units). The
    // client's own default is 100,000, one small put; a chunked put runs to
    // several hundred thousand, so start with 2 USDC. Unspent deposit comes
    // back when the channel settles.
    deposit: BigInt(env('LADING_CHANNEL_DEPOSIT', '2000000')),
  } as never);
}

type Paid<T> = { receipt: T; route: string; price: bigint | null };

/** The local record of a put: written as soon as the manifest is on Arweave, so a later failed leg is resumable with `lading name`. */
function save(sha: string, state: { manifest: NostrEvent; manifestTxId?: string; name?: NameReceipt; paid: Array<{ leg: string; route: string; price: bigint | null | string }> }): string {
  mkdirSync(join(HOME, 'manifests'), { recursive: true });
  const out = join(HOME, 'manifests', `${sha}.json`);
  writeFileSync(out, JSON.stringify({ ...state, paid: state.paid.map((p) => ({ ...p, price: p.price?.toString() })) }, null, 2));
  return out;
}

type Network = 'arweave' | 'walrus' | 'filecoin';
type PaidRow = { leg: string; route: string; price: bigint | null };
/** Parts bought so far for one object, so a put that dies mid-way resumes where it stopped instead of paying twice. */
interface Progress {
  legs: Partial<Record<Network, LegReceipt>>;
  parts: Partial<Record<Network, PartReceipt[]>>;
  paid: Array<{ leg: string; route: string; price: string | null }>;
}
const progressPath = (sha: string) => join(HOME, 'progress', `${sha}.json`);
function loadProgress(sha: string): Progress {
  const p = progressPath(sha);
  if (!existsSync(p)) return { legs: {}, parts: {}, paid: [] };
  return JSON.parse(readFileSync(p, 'utf8')) as Progress;
}
function saveProgress(sha: string, prog: Progress) {
  mkdirSync(join(HOME, 'progress'), { recursive: true });
  writeFileSync(progressPath(sha), JSON.stringify(prog, null, 2));
}
const clearProgress = (sha: string) => existsSync(progressPath(sha)) && rmSync(progressPath(sha));

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

/**
 * Run one network's leg over every part: reuse parts already bought, pay for
 * the rest one job at a time, save after each. A single part gives the same
 * leg shape as before chunking existed; several give a leg with `parts`.
 */
async function runLeg(opts: {
  network: Network;
  sha: string;
  size: number;
  parts: Part[];
  prog: Progress;
  paid: PaidRow[];
  t0: number;
  send: (part: Part, name: string) => Promise<PartOutcome>;
  line: (o: PartOutcome) => string;
}): Promise<LegReceipt> {
  const { network, parts, prog } = opts;
  const done = prog.legs[network];
  if (done) {
    console.log(`${network.padEnd(8)} ✓ ${done.id}${done.parts ? ` (${done.parts.length} parts)` : ''}  resumed, already bought`);
    return done;
  }
  const have = (prog.parts[network] ??= []);
  const outcomes: Array<{ part: Part; outcome: PartOutcome }> = [];
  let retention = '';
  let provider = '';
  let total = 0n;
  let known = true;
  for (const part of parts) {
    const tag = parts.length === 1 ? network.padEnd(8) : `${network}#${part.index + 1}/${parts.length}`.padEnd(8);
    const prior = have.find((r) => r.index === part.index);
    if (prior) {
      if (prior.sha256 !== part.sha256) throw new Error(`${network} part ${part.index} was bought for a different slice (${prior.sha256.slice(0, 12)}); pass --part-bytes as before, or delete ${progressPath(opts.sha)}`);
      const { retention: pr, provider: pp, ...pproof } = prior.proof ?? {};
      retention ||= String(pr ?? '');
      provider ||= String(pp ?? '');
      if (prior.paid) total += BigInt(prior.paid);
      else known = false;
      console.log(`${tag} ✓ ${prior.id}  resumed, already bought`);
      outcomes.push({ part, outcome: { id: prior.id, sha256: prior.sha256, proof: pproof, retention: String(pr ?? ''), provider: String(pp ?? ''), route: '', price: prior.paid ? BigInt(prior.paid) : null } });
      continue;
    }
    const o = await opts.send(part, partName(opt('name') ?? '', part.index, parts.length));
    if (o.sha256 !== undefined && o.sha256 !== part.sha256) throw new Error(`${network} receipt is for sha ${o.sha256}, not ${part.sha256}`);
    retention = o.retention;
    provider = o.provider;
    if (o.price === null) known = false;
    else total += o.price;
    opts.paid.push({ leg: parts.length === 1 ? network : `${network}#${part.index + 1}`, route: o.route, price: o.price });
    prog.paid.push({ leg: parts.length === 1 ? network : `${network}#${part.index + 1}`, route: o.route, price: o.price?.toString() ?? null });
    have.push({ index: part.index, id: o.id, sha256: part.sha256, size: part.size, proof: { ...o.proof, retention: o.retention, provider: o.provider }, ...(o.price !== null ? { paid: o.price.toString() } : {}) });
    saveProgress(opts.sha, prog);
    outcomes.push({ part, outcome: o });
    console.log(`${tag} ✓ ${opts.line(o)}  (${Date.now() - opts.t0} ms)`);
  }
  outcomes.sort((a, b) => a.part.index - b.part.index);
  const first = outcomes[0]!.outcome;
  retention ||= first.retention;
  provider ||= first.provider;
  const at = Math.floor(Date.now() / 1000);
  const paidStr = known ? total.toString() : undefined;
  const leg: LegReceipt =
    parts.length === 1
      ? { network, id: first.id, sha256: opts.sha, size: opts.size, retention, provider, proof: first.proof, ...(paidStr ? { paid: paidStr } : {}), at }
      : {
          network,
          id: first.id,
          sha256: opts.sha,
          size: opts.size,
          retention,
          provider,
          ...(paidStr ? { paid: paidStr } : {}),
          at,
          parts: outcomes.map(({ part, outcome }) => {
            const { retention: _r, provider: _p, ...proof } = outcome.proof ?? {};
            return { index: part.index, id: outcome.id, sha256: part.sha256, size: part.size, ...(Object.keys(proof).length ? { proof } : {}), ...(outcome.price !== null ? { paid: outcome.price.toString() } : {}) };
          }),
        };
  prog.legs[network] = leg;
  saveProgress(opts.sha, prog);
  return leg;
}

/** What the route will charge for this event: the ADR 0065 schedule applied to the payload length, or the flat price. */
async function charge(c: ToonClient, route: string, payloadLen: number): Promise<bigint | null> {
  const terms = await c.routePrice(route).catch(() => null);
  if (!terms) return null;
  try {
    return chargeFor(terms as never, payloadLen) as bigint;
  } catch {
    return c.price(route).catch(() => null);
  }
}

async function job<T>(c: ToonClient, route: string, event: NostrEvent, timeoutMs = 180_000): Promise<Paid<T>> {
  const price = await charge(c, route, Buffer.byteLength(JSON.stringify({ event })));
  const answer = await sendJob<T>({ client: c as never, destination: route, timeoutMs }, event as never);
  if (!answer.accepted) throw new Error(`${route}: ${answer.code} ${answer.message}`);
  return { receipt: answer.receipt, route, price };
}

/** Ask the walrus quote door whether an object of this size would go through right now. 1,000 units, against 40,000 for the leg. */
async function quoteWalrus(c: ToonClient, size: number, name: string): Promise<Paid<WalrusQuote>> {
  const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus', phase: 'quote', size: String(size), name } });
  return job<WalrusQuote>(c, ROUTES.walrusQuote, ev as never, 60_000);
}

/** Ask the filecoin quote door whether the broker's Filecoin Pay account can carry one more piece right now. 1,000 units, against 30,000 for the leg. */
async function quoteFilecoin(c: ToonClient, size: number, name: string): Promise<Paid<FilecoinQuote>> {
  const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'filecoin', phase: 'quote', size: String(size), name } });
  return job<FilecoinQuote>(c, ROUTES.filecoinQuote, ev as never, 60_000);
}

/** Ask the name quote door whether the broker can write this undername right now. 1,000 units, against 5,000 for the leg. */
async function quoteName(c: ToonClient, undername: string, txid?: string): Promise<Paid<NameQuote>> {
  const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'name', phase: 'quote', undername, ...(txid ? { txid } : {}) } });
  return job<NameQuote>(c, ROUTES.nameQuote, ev as never, 60_000);
}

/** Ask the renew quote door what one more year on a Lighthouse record costs and when it currently runs out. 1,000 units, against 40,000 for the renewal. */
async function quoteWalrusRenew(c: ToonClient, lighthouseId: string): Promise<Paid<WalrusRenewQuote>> {
  const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus-renew', phase: 'quote', lighthouseId } });
  return job<WalrusRenewQuote>(c, ROUTES.walrusRenewQuote, ev as never, 60_000);
}

const fmtRenewQuote = (q: WalrusRenewQuote) =>
  `${q.deliverable ? 'deliverable' : 'NOT deliverable'}, downstream ${q.downstream.amountUsdc} USDC, float ${q.float.balance} USDC on Base` +
  (q.currentExpiresAt ? `, paid through ${fmtDate(q.currentExpiresAt)} (${q.daysLeft} days)` : '') +
  (q.known ? '' : ', record not in the broker ledger') +
  (q.reason ? `: ${q.reason}` : '');

const fmtQuote = (q: WalrusQuote | FilecoinQuote | NameQuote) => {
  const head = q.deliverable ? 'deliverable' : 'NOT deliverable';
  const tail = q.reason ? `: ${q.reason}` : '';
  if (q.op === 'walrus') return `${head}, downstream ${q.downstream.amountUsdc} USDC, float ${q.float.balance} USDC on Base${tail}`;
  if (q.op === 'filecoin') return `${head}, add-piece fee ${q.downstream.addPieceFeeUsdfc} USDFC for ${q.copies} copies, float ${q.float.available} USDFC, runway ${/^\d+$/.test(q.float.runwayDays) ? `${q.float.runwayDays}d` : q.float.runwayDays}${tail}`;
  return `${head}, ${q.name}, float ${(Number(q.float.lamports) / 1e9).toFixed(4)} SOL${tail}`;
};

async function put(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const sha = sha256(bytes);
  const name = opt('name') ?? basename(file);
  const parts = splitParts(bytes, partBytes());
  const n = parts.length;
  const sk = nostrSecret();
  const payerPubkey = getPublicKey(sk);
  console.log(`${file}: ${bytes.length} bytes, sha256 ${sha}${n > 1 ? `, ${n} parts of up to ${Math.max(...parts.map((q) => q.size))} bytes` : ''}\npayer nostr pubkey ${payerPubkey}\nedge ${EDGE}`);
  const c = await client();
  const legs: LegReceipt[] = [];
  const paid: PaidRow[] = [];
  const prog = loadProgress(sha);
  if (Object.keys(prog.legs).length || Object.keys(prog.parts).length) {
    for (const row of prog.paid) paid.push({ ...row, price: row.price === null ? null : BigInt(row.price) });
    console.log(`resuming: ${Object.keys(prog.legs).join(',') || 'no'} legs and ${Object.entries(prog.parts).map(([k, v]) => `${k}=${v?.length ?? 0}`).join(' ') || 'no'} parts already bought`);
  }
  const t0 = Date.now();
  const blobEvent = (kind: number, params: Record<string, string>, part: Part, extra: string[][] = []) =>
    buildJobEvent({ kind, params, tags: [['i', Buffer.from(part.bytes).toString('base64'), 'blob'], ...extra] });

  // Leg 1: Arweave, through the org store. The store FULFILLs on the txId.
  if (!flag('skip-arweave')) {
    legs.push(
      await runLeg({
        network: 'arweave', sha, size: bytes.length, parts, prog, paid, t0,
        send: async (part) => {
          const ev = blobEvent(5094, {}, part, [['bid', '100000', 'usdc'], ['output', opt('mime') ?? 'application/octet-stream']]);
          const r = await job<{ txId?: string }>(c, ROUTES.ario, ev as never);
          const txId = r.receipt.txId;
          if (!txId) throw new Error(`arweave leg accepted without a txId: ${JSON.stringify(r.receipt)}`);
          return { id: txId, proof: { readUrl: `https://${GATEWAY}/${txId}` }, retention: 'permanent', provider: 'toon-store', route: r.route, price: r.price };
        },
        line: (o) => o.id,
      }),
    );
  }

  // Leg 2: Walrus, through Lading's door. Lading FULFILLs on the blobId.
  // Quoted first for the largest part: a leg the broker cannot deliver still
  // costs its route price. With several parts the float must cover them all.
  if (!flag('skip-walrus') && !prog.legs.walrus) {
    if (!flag('no-quote')) {
      const q = await quoteWalrus(c, Math.max(...parts.map((x) => x.size)), name);
      paid.push({ leg: 'walrus-quote', route: q.route, price: q.price });
      const left = n - (prog.parts.walrus?.length ?? 0);
      const need = timesMicro(q.receipt.downstream.amountUsdc, left);
      const short = q.receipt.deliverable && left > 1 && micro(q.receipt.float.balance) < micro(need);
      console.log(`walrus   quote ${fmtQuote(q.receipt)}${left > 1 ? `, ${left} parts need ${need} USDC` : ''}  (${Date.now() - t0} ms)`);
      if (!q.receipt.deliverable || short) throw new Error(`walrus leg would not go through; nothing paid for it. Re-run with --skip-walrus to archive without it. (${short ? `float ${q.receipt.float.balance} USDC is under the ${need} USDC that ${left} parts cost` : q.receipt.reason})`);
    }
  }
  if (!flag('skip-walrus')) {
    legs.push(
      await runLeg({
        network: 'walrus', sha, size: bytes.length, parts, prog, paid, t0,
        send: async (part, pname) => {
          const r = await job<WalrusReceipt>(c, ROUTES.walrus, blobEvent(LEG_KIND, { op: 'walrus', name: pname || name }, part) as never, 240_000);
          return { id: r.receipt.id, sha256: r.receipt.sha256, proof: r.receipt.proof, retention: r.receipt.retention, provider: r.receipt.provider, route: r.route, price: r.price };
        },
        line: (o) => `${o.id}  readback=${o.proof?.readback}`,
      }),
    );
  }

  // Leg 2b: Filecoin Onchain Cloud, through Lading's door. Lading FULFILLs on
  // the PieceCID once the provider has committed the piece and served it back.
  if (!flag('skip-filecoin')) {
    let go = true;
    if (!flag('no-quote') && !prog.legs.filecoin) {
      const q = await quoteFilecoin(c, Math.max(...parts.map((x) => x.size)), name);
      paid.push({ leg: 'filecoin-quote', route: q.route, price: q.price });
      const left = n - (prog.parts.filecoin?.length ?? 0);
      const need = timesMicro(q.receipt.downstream.addPieceFeeUsdfc, left);
      const short = q.receipt.deliverable && left > 1 && micro(q.receipt.float.available) < micro(need);
      console.log(`filecoin quote ${fmtQuote(q.receipt)}${left > 1 ? `, ${left} parts need ${need} USDFC in fees` : ''}  (${Date.now() - t0} ms)`);
      if (!q.receipt.deliverable || short) {
        go = false;
        console.log(`filecoin SKIPPED, nothing paid for it: ${short ? `available ${q.receipt.float.available} USDFC is under the ${need} USDFC that ${left} parts cost` : q.receipt.reason}`);
      }
    }
    if (go) {
      legs.push(
        await runLeg({
          network: 'filecoin', sha, size: bytes.length, parts, prog, paid, t0,
          send: async (part, pname) => {
            const r = await job<FilecoinReceipt>(c, ROUTES.filecoin, blobEvent(LEG_KIND, { op: 'filecoin', name: pname || name }, part) as never, 300_000);
            return { id: r.receipt.id, sha256: r.receipt.sha256, proof: r.receipt.proof, retention: r.receipt.retention, provider: r.receipt.provider, route: r.route, price: r.price };
          },
          line: (o) => `${o.id}  dataSet=${o.proof?.dataSetId} copies=${o.proof?.copies} readback=${o.proof?.readback}`,
        }),
      );
    }
  }

  if (legs.length === 0) throw new Error('every leg was skipped; nothing to attest');

  // The bill of lading, signed by the payer.
  const content: ManifestContent = {
    sha256: sha,
    size: bytes.length,
    mime: opt('mime'),
    legs,
    created: Math.floor(Date.now() / 1000),
  };
  let manifest = buildManifest(content, sk);

  // Leg 3: publish to the relay (a plain paid write of the signed event).
  if (!flag('skip-relay')) {
    const r = await c.send(ROUTES.relay, { body: { event: manifest } });
    const price = r.fulfilled ? (r.claim?.amount ?? null) : null;
    if (!r.fulfilled) throw new Error(`relay: ${r.code} ${r.message}`);
    paid.push({ leg: 'relay', route: ROUTES.relay, price });
    console.log(`relay    ✓ event ${manifest.id}  (${Date.now() - t0} ms)`);
  }

  // Leg 4: the manifest itself onto Arweave, then named.
  let manifestTxId: string | undefined;
  let nameReceipt: NameReceipt | undefined;
  if (!flag('skip-arweave')) {
    const ev = buildJobEvent({
      kind: 5094,
      params: {},
      tags: [
        ['i', Buffer.from(JSON.stringify(manifest)).toString('base64'), 'blob'],
        ['bid', '100000', 'usdc'],
        ['output', 'application/json'],
      ],
    });
    const r = await job<{ txId?: string }>(c, ROUTES.ario, ev as never);
    manifestTxId = r.receipt.txId;
    if (!manifestTxId) throw new Error('manifest write accepted without a txId');
    paid.push({ leg: 'manifest', route: r.route, price: r.price });
    console.log(`manifest ✓ ${manifestTxId}  (${Date.now() - t0} ms)`);
    save(sha, { manifest, manifestTxId, paid });
    clearProgress(sha);

    let nameOk = !flag('skip-name');
    const undername = opt('undername') ?? undernameFor(sha);
    if (nameOk && !flag('no-quote')) {
      const q = await quoteName(c, undername, manifestTxId);
      paid.push({ leg: 'name-quote', route: q.route, price: q.price });
      console.log(`name     quote ${fmtQuote(q.receipt)}  (${Date.now() - t0} ms)`);
      if (!q.receipt.deliverable) {
        nameOk = false;
        console.log(`name     SKIPPED, nothing paid for it; retry later with: lading name ${sha}`);
      }
    }
    if (nameOk) {
      const ev2 = buildJobEvent({ kind: LEG_KIND, params: { op: 'name', txid: manifestTxId, sha256: sha, undername } });
      const r2 = await job<NameReceipt>(c, ROUTES.name, ev2 as never, 120_000);
      nameReceipt = r2.receipt;
      paid.push({ leg: 'name', route: r2.route, price: r2.price });
      console.log(`name     ✓ ${nameReceipt.url}  (${Date.now() - t0} ms)`);
      // Re-sign with the name known, so the relay copy and the file copy agree on where the manifest lives.
      manifest = buildManifest({ ...content, arns: { undername, name: nameReceipt.name, manifestTxId } }, sk);
      if (!flag('skip-relay')) await c.send(ROUTES.relay, { body: { event: manifest } });
    }
  }

  const out = save(sha, { manifest, manifestTxId, name: nameReceipt, paid });
  clearProgress(sha);

  const total = paid.reduce((a, p) => a + (p.price ?? 0n), 0n);
  console.log('\nBILL OF LADING');
  for (const l of legs) console.log(`  ${l.network.padEnd(8)} ${l.id}  ${l.retention}${l.parts ? `  (${l.parts.length} parts)` : ''}`);
  if (manifestTxId) console.log(`  manifest https://${GATEWAY}/${manifestTxId}`);
  if (nameReceipt) console.log(`  name     ${nameReceipt.url}`);
  console.log(`  paid     ${total} base units across ${paid.length} jobs (${paid.map((p) => `${p.leg}=${p.price ?? '?'}`).join(' ')})`);
  console.log(`  saved    ${out}`);
  await (c as { close?: () => Promise<void> }).close?.();
}

async function nameOnly(sha: string) {
  const p = join(HOME, 'manifests', `${sha}.json`);
  if (!existsSync(p)) throw new Error(`no saved manifest for ${sha} at ${p}`);
  const saved = JSON.parse(readFileSync(p, 'utf8')) as { manifest: NostrEvent; manifestTxId?: string; name?: NameReceipt; paid: unknown[] };
  if (!saved.manifestTxId) throw new Error('saved manifest has no Arweave txId; run put again');
  if (saved.name) {
    console.log(`already named: ${saved.name.url}`);
    return;
  }
  const content = parseManifest(saved.manifest);
  const sk = nostrSecret();
  const c = await client();
  const undername = opt('undername') ?? undernameFor(sha);
  if (!flag('no-quote')) {
    const q = await quoteName(c, undername, saved.manifestTxId);
    console.log(`name     quote ${fmtQuote(q.receipt)}`);
    if (!q.receipt.deliverable) throw new Error(`name leg would not go through; nothing paid for it. (${q.receipt.reason})`);
  }
  const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'name', txid: saved.manifestTxId, sha256: sha, undername } });
  const r = await job<NameReceipt>(c, ROUTES.name, ev as never, 120_000);
  console.log(`name     ✓ ${r.receipt.url}`);
  const manifest = buildManifest({ ...content, arns: { undername, name: r.receipt.name, manifestTxId: saved.manifestTxId } }, sk);
  if (!flag('skip-relay')) {
    const rr = await c.send(ROUTES.relay, { body: { event: manifest } });
    console.log(rr.fulfilled ? `relay    ✓ re-signed manifest ${manifest.id}` : `relay    ✗ ${rr.code} ${rr.message}`);
  }
  writeFileSync(p, JSON.stringify({ ...saved, manifest, name: r.receipt, paid: [...saved.paid, { leg: 'name', route: r.route, price: r.price?.toString() }] }, null, 2));
  await (c as { close?: () => Promise<void> }).close?.();
}

async function fetchManifest(ref: string): Promise<NostrEvent> {
  if (existsSync(ref)) {
    const j = JSON.parse(readFileSync(ref, 'utf8'));
    return (j.manifest ?? j) as NostrEvent;
  }
  const url = /^[A-Za-z0-9_-]{43}$/.test(ref)
    ? `https://${GATEWAY}/${ref}`
    : ref.startsWith('http')
      ? ref
      : `https://${ref}.${GATEWAY}/`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as NostrEvent;
}

/** Where a network serves one id from, given what the receipt recorded. */
function readUrlFor(network: string, id: string, proof?: Record<string, string | number | undefined>): string | undefined {
  if (network === 'arweave') return `https://${GATEWAY}/${id}`;
  if (network === 'walrus') return String(proof?.ipfsUrl ?? `${AGGREGATOR}/v1/blobs/${id}`);
  return proof?.readUrl === undefined ? undefined : String(proof.readUrl);
}

async function fetchBytes(url: string): Promise<{ status: number; bytes?: Uint8Array }> {
  const r = await fetch(url);
  return r.ok ? { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) } : { status: r.status };
}

async function verify(ref: string) {
  const event = await fetchManifest(ref);
  const m = parseManifest(event);
  console.log(`manifest by ${event.pubkey} for sha256 ${m.sha256} (${m.size} bytes), ${m.legs.length} legs`);
  let ok = true;
  for (const leg of m.legs) {
    if (!leg.parts) {
      const url = readUrlFor(leg.network, leg.id, leg.proof);
      if (!url) {
        console.log(`  ${leg.network.padEnd(8)} ${leg.id}  no read url`);
        ok = false;
        continue;
      }
      const r = await fetchBytes(url);
      const got = r.bytes ? sha256(r.bytes) : undefined;
      const match = got === m.sha256;
      ok &&= match;
      console.log(`  ${leg.network.padEnd(8)} ${leg.id}  ${match ? '✓ sha256 match' : `✗ ${r.status}${got ? ` got ${got.slice(0, 12)}` : ''}`}`);
      continue;
    }
    // A chunked leg: every part must come back with its own sha256, and the
    // reassembled object must hash to the manifest's.
    const fetched: Array<{ index: number; sha256: string; bytes: Uint8Array }> = [];
    let legOk = true;
    for (const part of leg.parts) {
      const url = readUrlFor(leg.network, part.id, part.proof);
      const r = url ? await fetchBytes(url) : { status: 0 };
      const got = r.bytes ? sha256(r.bytes) : undefined;
      const match = got === part.sha256;
      legOk &&= match;
      console.log(`  ${`${leg.network}#${part.index + 1}`.padEnd(8)} ${part.id}  ${match ? '✓ part sha256 match' : `✗ ${url ? r.status : 'no read url'}${got ? ` got ${got.slice(0, 12)}` : ''}`}`);
      if (match && r.bytes) fetched.push({ index: part.index, sha256: part.sha256, bytes: r.bytes });
    }
    let whole: string | undefined;
    if (legOk && fetched.length === leg.parts.length) {
      try {
        whole = sha256(assembleParts(fetched));
      } catch (e) {
        console.log(`  ${leg.network.padEnd(8)} assembly failed: ${(e as Error).message}`);
      }
    }
    const match = whole === m.sha256;
    ok &&= match;
    console.log(`  ${leg.network.padEnd(8)} ${leg.parts.length} parts reassembled  ${match ? '✓ sha256 match' : `✗${whole ? ` got ${whole.slice(0, 12)}` : ''}`}`);
  }
  console.log(ok ? 'ALL LEGS VERIFIED' : 'VERIFICATION FAILED');
  process.exitCode = ok ? 0 : 1;
}

/** Every saved put, oldest first. */
function savedPuts(): Array<{ path: string; sha: string; saved: SavedPut }> {
  const dir = join(HOME, 'manifests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => ({ path: join(dir, f), sha: f.slice(0, 64), saved: JSON.parse(readFileSync(join(dir, f), 'utf8')) as SavedPut }))
    .sort((a, b) => a.saved.manifest.created_at - b.saved.manifest.created_at);
}

const partLabel = (r: RenewalRow) => (r.part < 0 ? '' : `#${r.part + 1}/${r.parts}`);

/** What the payer holds on Walrus and when each record runs out. Free: reads local files, and with --live Lighthouse's public price endpoint. */
async function renewals() {
  const within = Number(opt('within') ?? 60);
  const rows = savedPuts().flatMap(({ saved }) => walrusRecords(saved));
  if (rows.length === 0) {
    console.log(`no walrus records under ${join(HOME, 'manifests')}`);
    return;
  }
  if (flag('live')) {
    for (const r of rows) {
      const res = await fetch(`${LIGHTHOUSE_X402}/api/renew/price?id=${encodeURIComponent(r.lighthouseId)}`);
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
  console.log(`${rows.length} walrus records${flag('live') ? ', dates from Lighthouse now' : ', dates as of the last write or renewal'}; due = within ${within} days\n`);
  console.log(`  ${'due'.padEnd(4)} ${'paid through'.padEnd(12)} ${'days'.padStart(5)}  ${'object'.padEnd(12)} ${'part'.padEnd(6)} ${'blobId'.padEnd(43)} ${'lighthouse record'.padEnd(36)} renewals  name`);
  for (const r of rows) {
    const due = Number.isNaN(r.daysLeft) ? 'GONE' : r.daysLeft <= within ? 'DUE' : '';
    console.log(`  ${due.padEnd(4)} ${fmtDate(r.expiresAt).padEnd(12)} ${String(Number.isNaN(r.daysLeft) ? '-' : r.daysLeft).padStart(5)}  ${r.sha256.slice(0, 12)} ${partLabel(r).padEnd(6)} ${r.blobId.padEnd(43)} ${r.lighthouseId.padEnd(36)} ${String(r.renewals).padStart(8)}  ${r.name ?? ''}`);
  }
  const due = dueWithin(rows.filter((r) => !Number.isNaN(r.daysLeft)), within);
  if (due.length) console.log(`\n${due.length} due: lading renew ${[...new Set(due.map((r) => r.sha256))].map((s) => s.slice(0, 12)).join(' / ')}`);
}

/**
 * Buy one more year on Walrus. <ref> is a saved put's sha256 (every record of
 * that object, all parts) or one Lighthouse record id. Each record is quoted
 * first and only paid when its quote says deliverable; the saved file records
 * the new paid-through date so `lading renewals` reads it back.
 */
async function renew(ref: string) {
  const isSha = /^[0-9a-f]{64}$/.test(ref);
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  if (!isSha && !isId) throw new Error('renew wants a saved put sha256 or a Lighthouse record id');
  const puts = savedPuts();
  const targets: Array<{ lighthouseId: string; blobId?: string; put?: { path: string; saved: SavedPut }; label: string }> = [];
  if (isSha) {
    const put = puts.find((p) => p.sha === ref);
    if (!put) throw new Error(`no saved manifest for ${ref} under ${join(HOME, 'manifests')}`);
    for (const r of walrusRecords(put.saved)) targets.push({ lighthouseId: r.lighthouseId, blobId: r.blobId, put, label: `walrus${partLabel(r)}` });
    if (targets.length === 0) throw new Error(`the saved put ${ref.slice(0, 12)} has no walrus records`);
  } else {
    const put = puts.find((p) => walrusRecords(p.saved).some((r) => r.lighthouseId === ref));
    targets.push({ lighthouseId: ref, put, label: 'walrus' });
  }
  const c = await client();
  const t0 = Date.now();
  let total = 0n;
  let bought = 0;
  for (const t of targets) {
    const tag = t.label.padEnd(9);
    if (!flag('no-quote')) {
      const q = await quoteWalrusRenew(c, t.lighthouseId);
      total += q.price ?? 0n;
      console.log(`${tag} quote ${fmtRenewQuote(q.receipt)}  (${Date.now() - t0} ms)`);
      if (!q.receipt.deliverable) {
        console.log(`${tag} SKIPPED, nothing paid for it`);
        continue;
      }
    }
    const ev = buildJobEvent({ kind: LEG_KIND, params: { op: 'walrus-renew', lighthouseId: t.lighthouseId } });
    const r = await job<WalrusRenewReceipt>(c, ROUTES.walrusRenew, ev as never, 180_000);
    total += r.price ?? 0n;
    bought++;
    const rec: SavedRenewal = {
      network: 'walrus',
      lighthouseId: t.lighthouseId,
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
    console.log(`${tag} ✓ ${r.receipt.blobId}  ${fmtDate(r.receipt.previousExpiresAt)} -> ${fmtDate(r.receipt.expiresAt)}${rec.baseTx ? `  base tx ${rec.baseTx}` : ''}${t.put ? '' : '  (no saved put; not recorded locally)'}  (${Date.now() - t0} ms)`);
  }
  console.log(`\nrenewed ${bought} of ${targets.length} records, paid ${total} base units`);
  await (c as { close?: () => Promise<void> }).close?.();
}

async function describe() {
  const c = await client();
  for (const [k, route] of Object.entries(ROUTES)) {
    const p = await c.price(route).catch(() => null);
    console.log(`${k.padEnd(12)} ${route.padEnd(30)} ${p === null ? 'not priced' : `${p} base units`}`);
  }
  await (c as { close?: () => Promise<void> }).close?.();
}

/** The whole bill before paying it: route prices from the edge, deliverability from the three quote doors. Costs three quotes. */
async function quote(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const sha = sha256(bytes);
  const name = opt('name') ?? basename(file);
  const undername = opt('undername') ?? undernameFor(sha);
  const parts = planParts(bytes.length, partBytes());
  const n = parts.length;
  const largest = Math.max(...parts.map((q) => q.size));
  const c = await client();
  const eventBytes = (params: Record<string, string>, blobLen?: number) =>
    Buffer.byteLength(JSON.stringify({ event: buildJobEvent({ kind: LEG_KIND, params, tags: blobLen ? [['i', 'A'.repeat(Math.ceil(blobLen / 3) * 4), 'blob']] : [] }) }));
  const manifestGuess = 1200 + 3 * 400 + (n > 1 ? 3 * n * 400 : 0); // a manifest with three legs, plus part receipts, before signing
  const perPart = async (route: string) => {
    let sum = 0n;
    for (const p of parts) {
      const one = await charge(c, route, eventBytes({}, p.size));
      if (one === null) return null;
      sum += one;
    }
    return sum;
  };
  const times = (v: bigint | null) => (v === null ? null : v * BigInt(n));
  const partsNote = n > 1 ? ` × ${n} parts` : '';
  const rows: Array<[string, string, bigint | null, string]> = [];
  rows.push(['arweave', ROUTES.ario, await perPart(ROUTES.ario), `schedule on the payload${partsNote}`]);
  const wq = await quoteWalrus(c, largest, name);
  const wNeed = timesMicro(wq.receipt.downstream.amountUsdc, n);
  const wShort = wq.receipt.deliverable && n > 1 && micro(wq.receipt.float.balance) < micro(wNeed);
  rows.push(['walrus-quote', wq.route, wq.price, fmtQuote(wq.receipt) + (n > 1 ? `, ${n} parts need ${wNeed} USDC${wShort ? ' (SHORT)' : ''}` : '')]);
  rows.push(['walrus', ROUTES.walrus, wq.receipt.deliverable && !wShort ? times(await charge(c, ROUTES.walrus, 0)) : 0n, wq.receipt.deliverable && !wShort ? `flat${partsNote}` : 'would not be paid']);
  const fq = await quoteFilecoin(c, largest, name);
  const fNeed = timesMicro(fq.receipt.downstream.addPieceFeeUsdfc, n);
  const fShort = fq.receipt.deliverable && n > 1 && micro(fq.receipt.float.available) < micro(fNeed);
  rows.push(['filecoin-quote', fq.route, fq.price, fmtQuote(fq.receipt) + (n > 1 ? `, ${n} parts need ${fNeed} USDFC in fees${fShort ? ' (SHORT)' : ''}` : '')]);
  rows.push(['filecoin', ROUTES.filecoin, fq.receipt.deliverable && !fShort ? times(await charge(c, ROUTES.filecoin, 0)) : 0n, fq.receipt.deliverable && !fShort ? `flat${partsNote}` : 'would be skipped']);
  rows.push(['relay', ROUTES.relay, await charge(c, ROUTES.relay, manifestGuess), 'manifest copy']);
  rows.push(['manifest', ROUTES.ario, await charge(c, ROUTES.ario, manifestGuess), 'manifest on Arweave, estimate']);
  const nq = await quoteName(c, undername);
  rows.push(['name-quote', nq.route, nq.price, fmtQuote(nq.receipt)]);
  rows.push(['name', ROUTES.name, nq.receipt.deliverable ? await charge(c, ROUTES.name, 0) : 0n, nq.receipt.deliverable ? 'flat' : 'would be skipped']);
  console.log(`\n${file}: ${bytes.length} bytes, sha256 ${sha}${n > 1 ? `, ${n} parts of up to ${largest} bytes` : ''}`);
  for (const [leg, route, price, note] of rows) console.log(`  ${leg.padEnd(13)} ${route.padEnd(30)} ${String(price ?? '?').padStart(8)}  ${note}`);
  const total = rows.reduce((a, r) => a + (r[2] ?? 0n), 0n);
  console.log(`  ${'total'.padEnd(13)} ${''.padEnd(30)} ${total.toString().padStart(8)}  base units (${(Number(total) / 1e6).toFixed(4)} USDC), quotes paid now: ${(wq.price ?? 0n) + (fq.price ?? 0n) + (nq.price ?? 0n)}`);
  await (c as { close?: () => Promise<void> }).close?.();
}

const [cmd, arg] = process.argv.slice(2);
const run =
  cmd === 'put' && arg ? put(arg) : cmd === 'quote' && arg ? quote(arg) : cmd === 'verify' && arg ? verify(arg) : cmd === 'name' && arg ? nameOnly(arg) : cmd === 'renewals' ? renewals() : cmd === 'renew' && arg ? renew(arg) : cmd === 'describe' ? describe() : null;
if (!run) {
  console.log('usage: lading put <file> [--name n] [--mime m] [--undername u] [--part-bytes n] [--no-quote] [--skip-arweave|--skip-walrus|--skip-filecoin|--skip-relay|--skip-name]\n       lading quote <file> [--part-bytes n]\n       lading verify <arns-name|manifest-txid|saved.json>\n       lading name <sha256> [--no-quote]\n       lading renewals [--within days] [--live]\n       lading renew <sha256|lighthouse-record-id> [--no-quote]\n       lading describe');
  process.exit(2);
}
run.catch((e) => {
  console.error('error:', e?.message ?? e);
  process.exit(1);
});
