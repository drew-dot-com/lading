#!/usr/bin/env node
/**
 * The Lading client: the party that pays, and the one that composes legs.
 *
 *   lading put <file>       archive: arweave leg → walrus leg → filecoin leg →
 *                           sign the bill of lading → publish to relay → write
 *                           it to Arweave → name it on ArNS. Each leg is one paid job; a leg
 *                           that fails leaves nothing charged for it.
 *   lading verify <ref>     re-fetch every leg named in a manifest and compare
 *                           sha256. <ref> is an ArNS name, a manifest txId, or
 *                           a path to a saved manifest.
 *   lading name <sha>       retry the ArNS name leg for a saved manifest whose
 *                           earlier name job failed, without re-uploading.
 *   lading quote <file>     the full bill before paying it: every route's price
 *                           plus each leg's quote (deliverable right now, and
 *                           the downstream cost the broker will carry).
 *   lading describe         what the node serves.
 *
 * Coordination lives here, not in the handler: that is the pattern every TOON
 * app follows (a handler is a leaf), and it keeps the broker unable to spend
 * on the payer's behalf beyond the one leg it was paid for.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ToonClient, buildJobEvent, sendJob, chargeFor } from '@toon-protocol/client';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { LEG_KIND, type FilecoinReceipt, type LegReceipt, type NameReceipt, type WalrusReceipt } from './kinds.js';
import type { FilecoinQuote, NameQuote, WalrusQuote } from './quote.js';
import { buildManifest, parseManifest, type ManifestContent } from './manifest.js';
import { undernameFor } from './arns.js';

const env = (k: string, d: string) => process.env[k] ?? d;
const EDGE = env('TOON_EDGE', 'https://connector.167-233-221-236.sslip.io');
const ROUTES = {
  ario: env('LADING_ROUTE_ARIO', 'g.drew.ario'),
  walrus: env('LADING_ROUTE_WALRUS', 'g.drew.lading.walrus'),
  walrusQuote: env('LADING_ROUTE_WALRUS_QUOTE', 'g.drew.lading.walrus.quote'),
  filecoin: env('LADING_ROUTE_FILECOIN', 'g.drew.lading.filecoin'),
  filecoinQuote: env('LADING_ROUTE_FILECOIN_QUOTE', 'g.drew.lading.filecoin.quote'),
  name: env('LADING_ROUTE_NAME', 'g.drew.lading.name'),
  nameQuote: env('LADING_ROUTE_NAME_QUOTE', 'g.drew.lading.name.quote'),
  relay: env('LADING_ROUTE_RELAY', 'g.drew.relay'),
};
const GATEWAY = env('LADING_ARNS_GATEWAY', 'permagate.io');
const AGGREGATOR = env('WALRUS_AGGREGATOR_URL', 'https://aggregator.walrus-mainnet.walrus.space');
const HOME = join(homedir(), '.lading');

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

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
    rpcUrl: env('SOLANA_RPC', 'https://solana-rpc.publicnode.com'),
    transport: 'http',
    channelStore: env('LADING_CHANNEL_STORE', join(HOME, 'channel-store.json')),
    autoOpenChannel: true,
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

const fmtQuote = (q: WalrusQuote | FilecoinQuote | NameQuote) => {
  const head = q.deliverable ? 'deliverable' : 'NOT deliverable';
  const tail = q.reason ? `: ${q.reason}` : '';
  if (q.op === 'walrus') return `${head}, downstream ${q.downstream.amountUsdc} USDC, float ${q.float.balance} USDC on Base${tail}`;
  if (q.op === 'filecoin') return `${head}, add-piece fee ${q.downstream.addPieceFeeUsdfc} USDFC for ${q.copies} copies, float ${q.float.available} USDFC, runway ${q.float.runwayDays}d${tail}`;
  return `${head}, ${q.name}, float ${(Number(q.float.lamports) / 1e9).toFixed(4)} SOL${tail}`;
};

async function put(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const sha = sha256(bytes);
  const name = opt('name') ?? basename(file);
  const sk = nostrSecret();
  const payerPubkey = getPublicKey(sk);
  console.log(`${file}: ${bytes.length} bytes, sha256 ${sha}\npayer nostr pubkey ${payerPubkey}\nedge ${EDGE}`);
  const c = await client();
  const legs: LegReceipt[] = [];
  const paid: Array<{ leg: string; route: string; price: bigint | null }> = [];
  const t0 = Date.now();

  // Leg 1: Arweave, through the org store. The store FULFILLs on the txId.
  if (!flag('skip-arweave')) {
    const ev = buildJobEvent({
      kind: 5094,
      params: {},
      tags: [
        ['i', Buffer.from(bytes).toString('base64'), 'blob'],
        ['bid', '100000', 'usdc'],
        ['output', opt('mime') ?? 'application/octet-stream'],
      ],
    });
    const r = await job<{ txId?: string }>(c, ROUTES.ario, ev as never);
    const txId = r.receipt.txId;
    if (!txId) throw new Error(`arweave leg accepted without a txId: ${JSON.stringify(r.receipt)}`);
    legs.push({
      network: 'arweave',
      id: txId,
      sha256: sha,
      size: bytes.length,
      retention: 'permanent',
      provider: 'toon-store',
      proof: { readUrl: `https://${GATEWAY}/${txId}` },
      paid: r.price?.toString(),
      at: Math.floor(Date.now() / 1000),
    });
    paid.push({ leg: 'arweave', route: r.route, price: r.price });
    console.log(`arweave  ✓ ${txId}  (${Date.now() - t0} ms)`);
  }

  // Leg 2: Walrus, through Lading's door. Lading FULFILLs on the blobId.
  // Quoted first: a leg the broker cannot deliver still costs its route price.
  if (!flag('skip-walrus')) {
    if (!flag('no-quote')) {
      const q = await quoteWalrus(c, bytes.length, name);
      paid.push({ leg: 'walrus-quote', route: q.route, price: q.price });
      console.log(`walrus   quote ${fmtQuote(q.receipt)}  (${Date.now() - t0} ms)`);
      if (!q.receipt.deliverable) throw new Error(`walrus leg would not go through; nothing paid for it. Re-run with --skip-walrus to archive without it. (${q.receipt.reason})`);
    }
    const ev = buildJobEvent({
      kind: LEG_KIND,
      params: { op: 'walrus', name },
      tags: [['i', Buffer.from(bytes).toString('base64'), 'blob']],
    });
    const r = await job<WalrusReceipt>(c, ROUTES.walrus, ev as never, 240_000);
    if (r.receipt.sha256 !== sha) throw new Error(`walrus receipt is for sha ${r.receipt.sha256}, not ${sha}`);
    legs.push({ ...r.receipt, paid: r.price?.toString() });
    paid.push({ leg: 'walrus', route: r.route, price: r.price });
    console.log(`walrus   ✓ ${r.receipt.id}  readback=${r.receipt.proof.readback}  (${Date.now() - t0} ms)`);
  }

  // Leg 2b: Filecoin Onchain Cloud, through Lading's door. Lading FULFILLs on
  // the PieceCID once the provider has committed the piece and served it back.
  if (!flag('skip-filecoin')) {
    let go = true;
    if (!flag('no-quote')) {
      const q = await quoteFilecoin(c, bytes.length, name);
      paid.push({ leg: 'filecoin-quote', route: q.route, price: q.price });
      console.log(`filecoin quote ${fmtQuote(q.receipt)}  (${Date.now() - t0} ms)`);
      if (!q.receipt.deliverable) {
        go = false;
        console.log(`filecoin SKIPPED, nothing paid for it: ${q.receipt.reason}`);
      }
    }
    if (go) {
      const ev = buildJobEvent({
        kind: LEG_KIND,
        params: { op: 'filecoin', name },
        tags: [['i', Buffer.from(bytes).toString('base64'), 'blob']],
      });
      const r = await job<FilecoinReceipt>(c, ROUTES.filecoin, ev as never, 300_000);
      if (r.receipt.sha256 !== sha) throw new Error(`filecoin receipt is for sha ${r.receipt.sha256}, not ${sha}`);
      legs.push({ ...r.receipt, paid: r.price?.toString() });
      paid.push({ leg: 'filecoin', route: r.route, price: r.price });
      console.log(`filecoin ✓ ${r.receipt.id}  dataSet=${r.receipt.proof.dataSetId} copies=${r.receipt.proof.copies} readback=${r.receipt.proof.readback}  (${Date.now() - t0} ms)`);
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

  const total = paid.reduce((a, p) => a + (p.price ?? 0n), 0n);
  console.log('\nBILL OF LADING');
  for (const l of legs) console.log(`  ${l.network.padEnd(8)} ${l.id}  ${l.retention}`);
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

async function verify(ref: string) {
  const event = await fetchManifest(ref);
  const m = parseManifest(event);
  console.log(`manifest by ${event.pubkey} for sha256 ${m.sha256} (${m.size} bytes), ${m.legs.length} legs`);
  let ok = true;
  for (const leg of m.legs) {
    const url =
      leg.network === 'arweave'
        ? `https://${GATEWAY}/${leg.id}`
        : leg.network === 'walrus'
          ? (leg.proof?.ipfsUrl ?? `${AGGREGATOR}/v1/blobs/${leg.id}`)
          : leg.proof?.readUrl;
    if (!url) {
      console.log(`  ${leg.network.padEnd(8)} ${leg.id}  no read url`);
      ok = false;
      continue;
    }
    const r = await fetch(String(url));
    const got = r.ok ? sha256(new Uint8Array(await r.arrayBuffer())) : undefined;
    const match = got === m.sha256;
    ok &&= match;
    console.log(`  ${leg.network.padEnd(8)} ${leg.id}  ${match ? '✓ sha256 match' : `✗ ${r.status}${got ? ` got ${got.slice(0, 12)}` : ''}`}`);
  }
  console.log(ok ? 'ALL LEGS VERIFIED' : 'VERIFICATION FAILED');
  process.exitCode = ok ? 0 : 1;
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
  const c = await client();
  const eventBytes = (params: Record<string, string>, blob?: Uint8Array) =>
    Buffer.byteLength(JSON.stringify({ event: buildJobEvent({ kind: LEG_KIND, params, tags: blob ? [['i', Buffer.from(blob).toString('base64'), 'blob']] : [] }) }));
  const manifestGuess = 1200 + 3 * 400; // a manifest with three legs, before signing
  const rows: Array<[string, string, bigint | null, string]> = [];
  rows.push(['arweave', ROUTES.ario, await charge(c, ROUTES.ario, eventBytes({}, bytes)), 'schedule on the payload']);
  const wq = await quoteWalrus(c, bytes.length, name);
  rows.push(['walrus-quote', wq.route, wq.price, fmtQuote(wq.receipt)]);
  rows.push(['walrus', ROUTES.walrus, wq.receipt.deliverable ? await charge(c, ROUTES.walrus, 0) : 0n, wq.receipt.deliverable ? 'flat' : 'would not be paid']);
  const fq = await quoteFilecoin(c, bytes.length, name);
  rows.push(['filecoin-quote', fq.route, fq.price, fmtQuote(fq.receipt)]);
  rows.push(['filecoin', ROUTES.filecoin, fq.receipt.deliverable ? await charge(c, ROUTES.filecoin, 0) : 0n, fq.receipt.deliverable ? 'flat' : 'would be skipped']);
  rows.push(['relay', ROUTES.relay, await charge(c, ROUTES.relay, manifestGuess), 'manifest copy']);
  rows.push(['manifest', ROUTES.ario, await charge(c, ROUTES.ario, manifestGuess), 'manifest on Arweave, estimate']);
  const nq = await quoteName(c, undername);
  rows.push(['name-quote', nq.route, nq.price, fmtQuote(nq.receipt)]);
  rows.push(['name', ROUTES.name, nq.receipt.deliverable ? await charge(c, ROUTES.name, 0) : 0n, nq.receipt.deliverable ? 'flat' : 'would be skipped']);
  console.log(`\n${file}: ${bytes.length} bytes, sha256 ${sha}`);
  for (const [leg, route, price, note] of rows) console.log(`  ${leg.padEnd(13)} ${route.padEnd(30)} ${String(price ?? '?').padStart(8)}  ${note}`);
  const total = rows.reduce((a, r) => a + (r[2] ?? 0n), 0n);
  console.log(`  ${'total'.padEnd(13)} ${''.padEnd(30)} ${total.toString().padStart(8)}  base units (${(Number(total) / 1e6).toFixed(4)} USDC), quotes paid now: ${(wq.price ?? 0n) + (fq.price ?? 0n) + (nq.price ?? 0n)}`);
  await (c as { close?: () => Promise<void> }).close?.();
}

const [cmd, arg] = process.argv.slice(2);
const run =
  cmd === 'put' && arg ? put(arg) : cmd === 'quote' && arg ? quote(arg) : cmd === 'verify' && arg ? verify(arg) : cmd === 'name' && arg ? nameOnly(arg) : cmd === 'describe' ? describe() : null;
if (!run) {
  console.log('usage: lading put <file> [--name n] [--mime m] [--undername u] [--no-quote] [--skip-arweave|--skip-walrus|--skip-filecoin|--skip-relay|--skip-name]\n       lading quote <file>\n       lading verify <arns-name|manifest-txid|saved.json>\n       lading name <sha256> [--no-quote]\n       lading describe');
  process.exit(2);
}
run.catch((e) => {
  console.error('error:', e?.message ?? e);
  process.exit(1);
});
