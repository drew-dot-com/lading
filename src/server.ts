/**
 * Lading's handler: the doors a TOON connector terminates routes at.
 *
 *   POST /walrus         kind:5320, `['i', base64, 'blob']`  → WalrusReceipt
 *   POST /filecoin       kind:5320, `['i', base64, 'blob']`  → FilecoinReceipt
 *   POST /name           kind:5320, params op=name, txid, undername → NameReceipt
 *   POST /walrus/quote   kind:5320, params op=walrus, phase=quote, size → WalrusQuote
 *   POST /walrus/renew   kind:5320, params op=walrus-renew, lighthouseId → WalrusRenewReceipt
 *   POST /walrus/renew/quote kind:5320, params op=walrus-renew, phase=quote, lighthouseId → WalrusRenewQuote
 *   GET  /walrus/ledger  every Lighthouse record this broker paid for, soonest expiry first (operator view)
 *   POST /filecoin/quote kind:5320, params op=filecoin, phase=quote, size → FilecoinQuote
 *   POST /name/quote     kind:5320, params op=name, phase=quote, undername, txid → NameQuote
 *   GET  /describe what this node serves, derived from what booted
 *   GET  /health
 *
 * Payment is the connector's business: by the time a request lands here the
 * claim has been verified and the route's price charged. This process holds
 * no payment logic. It reads the ADR 0040 headers for the log line only.
 *
 * FULFILL (`accept: true`) is sent only once the downstream network handed
 * back its receipt; anything short of that is `accept: false`, so nothing is
 * bought downstream for a failed leg. The connector still charges the route
 * price for the delivered packet, which is why each leg has a quote door: a
 * cheap answer to "would this go through right now" before the real price.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { LEG_KIND, MANIFEST_KIND } from './kinds.js';
import { lighthouseUploader, sha256Hex, LIGHTHOUSE_X402, WALRUS_AGGREGATOR, type WalrusUploader } from './walrus.js';
import { solanaNamer, undernameFor, UNDERNAME_RE, type Namer } from './arns.js';
import { cached, decideFilecoin, decideName, decideWalrus, decideWalrusRenew, type FilecoinQuote, type NameQuote, type WalrusQuote, type WalrusRenewQuote } from './quote.js';
import { daysLeft, openLedger, type Ledger } from './ledger.js';
import { filecoinChain, synapseUploader, runwayText, FILECOIN_MIN_BYTES, type FilecoinUploader } from './filecoin.js';
import { createPublicClient, http as viemHttp, erc20Abi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createSolanaRpc, address as solAddress } from '@solana/kit';

const PORT = Number(process.env.PORT ?? 3600);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 3 * 1024 * 1024);
const DEV_MODE = process.env.DEV_MODE === '1';
import { VERSION } from './version.js';
/** Lamports the name key must hold before a name job is quoted deliverable: record rent (~2.81M) plus fee, with a margin for a second job in flight. */
const NAME_NEED_LAMPORTS = BigInt(process.env.LADING_NAME_NEED_LAMPORTS ?? 6_000_000);
/** The Base key must hold this many times the downstream price before a walrus job is quoted deliverable. */
const WALRUS_RESERVE_MULTIPLE = Number(process.env.LADING_WALRUS_RESERVE_MULTIPLE ?? 2);
/** Days of Filecoin Pay runway the broker must hold before a filecoin job is quoted deliverable. */
const FILECOIN_MIN_RUNWAY_DAYS = BigInt(process.env.LADING_FILECOIN_MIN_RUNWAY_DAYS ?? 7);
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const BASE_RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org';
const FLOAT_CACHE_MS = 30_000;
/** Where the broker keeps its ledger of Walrus records. Unset = memory only. */
const DATA_DIR = process.env.LADING_DATA_DIR;

const paramOf = (event: NostrEvent, key: string) =>
  event.tags.find((t) => t[0] === 'param' && t[1] === key)?.[2];
const inputOf = (event: NostrEvent, type: string) =>
  event.tags.find((t) => t[0] === 'i' && t[2] === type)?.[1];

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const refuse = (res: ServerResponse, status: number, code: 'F00' | 'T00', message: string) =>
  send(res, status, { accept: false, code, message });
const acceptReceipt = (res: ServerResponse, receipt: unknown, meta: Record<string, unknown>) =>
  send(res, 200, {
    accept: true,
    data: Buffer.from(JSON.stringify(receipt)).toString('base64'),
    result: receipt,
    ...meta,
  });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) throw new Error(`body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Everything a door needs before it runs: a verified event of the right kind, and the payment headers for the log. */
async function openJob(req: IncomingMessage, res: ServerResponse, op: string, phase: 'execute' | 'quote' = 'execute') {
  const meta = {
    payer: req.headers['x-toon-payer'],
    amount: req.headers['x-toon-amount'],
    chain: req.headers['x-toon-chain'],
  };
  let body: { event?: unknown };
  try {
    body = (await readJson(req)) as { event?: unknown };
  } catch (e) {
    refuse(res, 422, 'F00', (e as Error).message);
    return null;
  }
  const event = body?.event as NostrEvent | undefined;
  if (!event || typeof event !== 'object') {
    refuse(res, 422, 'F00', 'Missing required field: event');
    return null;
  }
  if (!DEV_MODE && !verifyEvent(event)) {
    refuse(res, 422, 'F00', 'Invalid event signature');
    return null;
  }
  if (event.kind !== LEG_KIND) {
    refuse(res, 422, 'F00', `Unsupported kind ${event.kind}; this door serves kind ${LEG_KIND}`);
    return null;
  }
  const declared = paramOf(event, 'op');
  if (declared !== undefined && declared !== op) {
    refuse(res, 422, 'F00', `op=${declared} sent to the ${op} door`);
    return null;
  }
  // A quote-shaped event never runs a leg: the execute door refuses it before
  // touching any downstream network, so a mis-routed quote costs the route
  // price and nothing else.
  if (phase === 'execute' && paramOf(event, 'phase') === 'quote') {
    refuse(res, 422, 'F00', `phase=quote sent to the ${op} execute door; pay the ${op} quote route instead`);
    return null;
  }
  return { event, meta };
}

function walrusDoor(uploader: WalrusUploader, ledger: Ledger) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'walrus');
    if (!job) return;
    const { event, meta } = job;
    const b64 = inputOf(event, 'blob');
    if (!b64) return refuse(res, 422, 'F00', "Missing input: ['i', <base64>, 'blob']");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    } catch {
      return refuse(res, 422, 'F00', 'blob input is not base64');
    }
    if (bytes.length === 0) return refuse(res, 422, 'F00', 'blob is empty');
    const fileName = paramOf(event, 'name') ?? `${sha256Hex(bytes).slice(0, 12)}.bin`;
    const t0 = Date.now();
    try {
      const receipt = await uploader.upload(bytes, fileName);
      const lighthouseId = String(receipt.proof.lighthouseId ?? '');
      if (lighthouseId) {
        ledger.upsert({
          lighthouseId,
          blobId: receipt.id,
          cid: String(receipt.proof.cid ?? ''),
          sha256: receipt.sha256,
          size: receipt.size,
          expiresAt: Number(receipt.proof.expiresAt ?? 0),
          paidAt: receipt.at,
          renewals: 0,
          last: 'upload',
          lastAt: receipt.at,
          ...(receipt.proof.baseTx ? { baseTx: String(receipt.proof.baseTx) } : {}),
        });
      }
      console.log(
        `walrus ok ${bytes.length}B sha=${receipt.sha256.slice(0, 12)} blob=${receipt.id} readback=${receipt.proof.readback ?? '?'} ` +
          `payer=${meta.payer ?? '-'} amount=${meta.amount ?? '-'} chain=${meta.chain ?? '-'} ${Date.now() - t0}ms`,
      );
      return acceptReceipt(res, receipt, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`walrus REJECT ${bytes.length}B payer=${meta.payer ?? '-'} ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `walrus leg failed, nothing charged downstream: ${msg}`);
    }
  };
}

/** The Base key's USDC balance, cached: one read per FLOAT_CACHE_MS however many quotes arrive. */
function walrusFloat(evmKey: `0x${string}`) {
  const account = privateKeyToAccount(evmKey);
  const client = createPublicClient({ chain: base, transport: viemHttp(BASE_RPC) });
  const read = cached(FLOAT_CACHE_MS, async () => {
    const raw = await client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    return formatUnits(raw, 6);
  });
  return { address: account.address, read };
}

function walrusQuoteDoor(uploader: WalrusUploader, float: ReturnType<typeof walrusFloat>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'walrus', 'quote');
    if (!job) return;
    const { event, meta } = job;
    const b64 = inputOf(event, 'blob');
    const sizeParam = paramOf(event, 'size');
    const size = b64 ? Buffer.from(b64, 'base64').length : Number(sizeParam);
    if (!Number.isInteger(size) || size < 0) return refuse(res, 422, 'F00', 'param size (bytes) or a blob input is required');
    const t0 = Date.now();
    try {
      const [price, balance] = await Promise.all([uploader.quote(Math.max(size, 1)), float.read()]);
      const d = decideWalrus({ size, maxBytes: MAX_BODY_BYTES, priceUsdc: price.amountUsdc, balanceUsdc: balance, reserveMultiple: WALRUS_RESERVE_MULTIPLE });
      const quote: WalrusQuote = {
        op: 'walrus',
        deliverable: d.deliverable,
        ...(d.reason ? { reason: d.reason } : {}),
        size,
        maxBytes: MAX_BODY_BYTES,
        downstream: { provider: 'lighthouse-x402', amountUsdc: price.amountUsdc, retention: 'P365D' },
        float: { chain: 'base', asset: 'USDC', balance, reserve: d.reserveUsdc },
        executeDoor: '/walrus',
        at: Math.floor(Date.now() / 1000),
      };
      console.log(`walrus quote ${size}B deliverable=${d.deliverable} downstream=${price.amountUsdc} float=${balance} payer=${meta.payer ?? '-'} ${Date.now() - t0}ms${d.reason ? `: ${d.reason}` : ''}`);
      return acceptReceipt(res, quote, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`walrus quote REJECT ${size}B ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `walrus quote failed: ${msg}`);
    }
  };
}

const LIGHTHOUSE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the record a renew job names: a Lighthouse record id, or a blobId the ledger knows. */
function renewTarget(event: NostrEvent, ledger: Ledger): { lighthouseId?: string; error?: string } {
  const id = paramOf(event, 'lighthouseId') ?? paramOf(event, 'id');
  if (id) return LIGHTHOUSE_ID_RE.test(id) ? { lighthouseId: id } : { error: `param lighthouseId ${id} is not a Lighthouse record id` };
  const blobId = paramOf(event, 'blobId');
  if (blobId) {
    const row = ledger.byBlobId(blobId);
    return row ? { lighthouseId: row.lighthouseId } : { error: `blobId ${blobId} is not in this broker's ledger; pass the Lighthouse record id from the manifest proof` };
  }
  return { error: 'param lighthouseId (from the walrus leg proof) or blobId is required' };
}

function walrusRenewQuoteDoor(uploader: WalrusUploader, float: ReturnType<typeof walrusFloat>, ledger: Ledger) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'walrus-renew', 'quote');
    if (!job) return;
    const { event, meta } = job;
    const target = renewTarget(event, ledger);
    if (!target.lighthouseId) return refuse(res, 422, 'F00', target.error!);
    const lighthouseId = target.lighthouseId;
    const t0 = Date.now();
    try {
      const [q, balance] = await Promise.all([uploader.renewQuote(lighthouseId), float.read()]);
      const d = decideWalrusRenew({ found: q.found, priceUsdc: q.amountUsdc, balanceUsdc: balance, reserveMultiple: WALRUS_RESERVE_MULTIPLE });
      const row = ledger.get(lighthouseId);
      if (row && q.found && q.currentExpiresAt && q.currentExpiresAt !== row.expiresAt) {
        ledger.upsert({ ...row, expiresAt: q.currentExpiresAt, last: 'refresh', lastAt: Math.floor(Date.now() / 1000) });
      }
      const quote: WalrusRenewQuote = {
        op: 'walrus-renew',
        deliverable: d.deliverable,
        ...(d.reason ? { reason: d.reason } : {}),
        lighthouseId,
        ...(q.cid ? { cid: q.cid } : {}),
        ...(row ? { blobId: row.blobId } : {}),
        ...(q.size !== undefined ? { size: q.size } : {}),
        ...(q.currentExpiresAt ? { currentExpiresAt: q.currentExpiresAt, daysLeft: daysLeft(q.currentExpiresAt) } : {}),
        known: !!row,
        downstream: { provider: 'lighthouse-x402', amountUsdc: q.amountUsdc, extends: 'P365D' },
        float: { chain: 'base', asset: 'USDC', balance, reserve: d.reserveUsdc },
        executeDoor: '/walrus/renew',
        at: Math.floor(Date.now() / 1000),
      };
      console.log(`walrus renew quote ${lighthouseId} deliverable=${d.deliverable} known=${!!row} downstream=${q.amountUsdc} float=${balance} payer=${meta.payer ?? '-'} ${Date.now() - t0}ms${d.reason ? `: ${d.reason}` : ''}`);
      return acceptReceipt(res, quote, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`walrus renew quote REJECT ${lighthouseId} ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `walrus renew quote failed: ${msg}`);
    }
  };
}

function walrusRenewDoor(uploader: WalrusUploader, ledger: Ledger) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'walrus-renew');
    if (!job) return;
    const { event, meta } = job;
    const target = renewTarget(event, ledger);
    if (!target.lighthouseId) return refuse(res, 422, 'F00', target.error!);
    const lighthouseId = target.lighthouseId;
    const t0 = Date.now();
    try {
      const receipt = await uploader.renew(lighthouseId);
      const row = ledger.get(lighthouseId);
      ledger.upsert({
        lighthouseId,
        blobId: receipt.blobId,
        cid: receipt.cid,
        sha256: row?.sha256 ?? '',
        size: receipt.size,
        expiresAt: receipt.expiresAt,
        paidAt: row?.paidAt ?? receipt.at,
        renewals: (row?.renewals ?? 0) + 1,
        last: 'renew',
        lastAt: receipt.at,
        ...(receipt.proof.baseTx ? { baseTx: String(receipt.proof.baseTx) } : row?.baseTx ? { baseTx: row.baseTx } : {}),
      });
      console.log(`walrus renew ok ${lighthouseId} blob=${receipt.blobId} ${new Date(receipt.previousExpiresAt).toISOString().slice(0, 10)} -> ${new Date(receipt.expiresAt).toISOString().slice(0, 10)} payer=${meta.payer ?? '-'} amount=${meta.amount ?? '-'} ${Date.now() - t0}ms`);
      return acceptReceipt(res, receipt, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`walrus renew REJECT ${lighthouseId} payer=${meta.payer ?? '-'} ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `walrus renewal failed, nothing charged downstream: ${msg}`);
    }
  };
}

function filecoinDoor(uploader: FilecoinUploader) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'filecoin');
    if (!job) return;
    const { event, meta } = job;
    const b64 = inputOf(event, 'blob');
    if (!b64) return refuse(res, 422, 'F00', "Missing input: ['i', <base64>, 'blob']");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    } catch {
      return refuse(res, 422, 'F00', 'blob input is not base64');
    }
    if (bytes.length === 0) return refuse(res, 422, 'F00', 'blob is empty');
    if (bytes.length < FILECOIN_MIN_BYTES) return refuse(res, 422, 'F00', `blob is ${bytes.length} bytes, under the ${FILECOIN_MIN_BYTES}-byte Filecoin piece minimum`);
    const fileName = paramOf(event, 'name') ?? `${sha256Hex(bytes).slice(0, 12)}.bin`;
    const t0 = Date.now();
    try {
      const receipt = await uploader.upload(bytes, fileName);
      console.log(
        `filecoin ok ${bytes.length}B sha=${receipt.sha256.slice(0, 12)} piece=${receipt.id} dataSet=${receipt.proof.dataSetId} copies=${receipt.proof.copies} readback=${receipt.proof.readback ?? '?'} ` +
          `payer=${meta.payer ?? '-'} amount=${meta.amount ?? '-'} chain=${meta.chain ?? '-'} ${Date.now() - t0}ms`,
      );
      return acceptReceipt(res, receipt, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`filecoin REJECT ${bytes.length}B payer=${meta.payer ?? '-'} ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `filecoin leg failed, nothing charged downstream: ${msg}`);
    }
  };
}

function filecoinQuoteDoor(uploader: FilecoinUploader, info: () => Promise<Awaited<ReturnType<FilecoinUploader['quote']>>>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'filecoin', 'quote');
    if (!job) return;
    const { event, meta } = job;
    const b64 = inputOf(event, 'blob');
    const sizeParam = paramOf(event, 'size');
    const size = b64 ? Buffer.from(b64, 'base64').length : Number(sizeParam);
    if (!Number.isInteger(size) || size < 0) return refuse(res, 422, 'F00', 'param size (bytes) or a blob input is required');
    const t0 = Date.now();
    try {
      const q = await info();
      const d = decideFilecoin({ size, minBytes: FILECOIN_MIN_BYTES, maxBytes: MAX_BODY_BYTES, ready: q.ready, depositNeededUsdfc: q.depositNeededUsdfc, runwayDays: q.runwayDays, minRunwayDays: FILECOIN_MIN_RUNWAY_DAYS });
      const quote: FilecoinQuote = {
        op: 'filecoin',
        deliverable: d.deliverable,
        ...(d.reason ? { reason: d.reason } : {}),
        size,
        minBytes: FILECOIN_MIN_BYTES,
        maxBytes: MAX_BODY_BYTES,
        copies: uploader.copies,
        downstream: { provider: 'filecoin-onchain-cloud', chain: `filecoin:${uploader.chain.id}`, addPieceFeeUsdfc: q.addPieceFeeUsdfc, ratePerMonthUsdfc: q.ratePerMonthUsdfc, retention: 'per-epoch' },
        float: { chain: `filecoin:${uploader.chain.id}`, asset: 'USDFC', available: q.availableUsdfc, depositNeeded: q.depositNeededUsdfc, runwayDays: runwayText(q.runwayDays), fil: q.filBalance },
        executeDoor: '/filecoin',
        at: Math.floor(Date.now() / 1000),
      };
      console.log(`filecoin quote ${size}B deliverable=${d.deliverable} fee=${q.addPieceFeeUsdfc} available=${q.availableUsdfc} runway=${runwayText(q.runwayDays)} payer=${meta.payer ?? '-'} ${Date.now() - t0}ms${d.reason ? `: ${d.reason}` : ''}`);
      return acceptReceipt(res, quote, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`filecoin quote REJECT ${size}B ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `filecoin quote failed: ${msg}`);
    }
  };
}

function nameQuoteDoor(namer: Namer, lamports: () => Promise<bigint>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'name', 'quote');
    if (!job) return;
    const { event, meta } = job;
    const txid = paramOf(event, 'txid');
    const sha = paramOf(event, 'sha256');
    const undername = paramOf(event, 'undername') ?? (sha && /^[0-9a-f]{64}$/.test(sha) ? undernameFor(sha) : '');
    const t0 = Date.now();
    try {
      const [have, authorized] = await Promise.all([lamports(), namer.authorized()]);
      const d = decideName({
        undernameOk: UNDERNAME_RE.test(undername) && undername !== '@',
        txidOk: txid === undefined || /^[A-Za-z0-9_-]{43}$/.test(txid),
        authorized,
        lamports: have,
        needLamports: NAME_NEED_LAMPORTS,
      });
      const quote: NameQuote = {
        op: 'name',
        deliverable: d.deliverable,
        ...(d.reason ? { reason: d.reason } : {}),
        undername,
        name: `${undername}_${namer.baseName}`,
        antId: namer.antId,
        float: { chain: 'solana', asset: 'SOL', lamports: have.toString(), needLamports: NAME_NEED_LAMPORTS.toString() },
        executeDoor: '/name',
        at: Math.floor(Date.now() / 1000),
      };
      console.log(`name quote ${undername || '?'} deliverable=${d.deliverable} float=${have} payer=${meta.payer ?? '-'} ${Date.now() - t0}ms${d.reason ? `: ${d.reason}` : ''}`);
      return acceptReceipt(res, quote, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`name quote REJECT ${undername || '?'} ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `name quote failed: ${msg}`);
    }
  };
}

function nameDoor(namer: Namer) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const job = await openJob(req, res, 'name');
    if (!job) return;
    const { event, meta } = job;
    const txid = paramOf(event, 'txid');
    if (!txid || !/^[A-Za-z0-9_-]{43}$/.test(txid)) return refuse(res, 422, 'F00', 'param txid must be an Arweave txId');
    const sha = paramOf(event, 'sha256');
    const undername = paramOf(event, 'undername') ?? (sha && /^[0-9a-f]{64}$/.test(sha) ? undernameFor(sha) : undefined);
    if (!undername) return refuse(res, 422, 'F00', 'param undername, or a sha256 to derive one from, is required');
    if (!UNDERNAME_RE.test(undername) || undername === '@') return refuse(res, 422, 'F00', `bad undername ${undername}`);
    const t0 = Date.now();
    try {
      const receipt = await namer.setUndername(undername, txid);
      console.log(`name ok ${receipt.name} -> ${txid} payer=${meta.payer ?? '-'} ${Date.now() - t0}ms`);
      return acceptReceipt(res, receipt, meta);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`name REJECT ${undername} ${Date.now() - t0}ms: ${msg}`);
      return refuse(res, 502, 'T00', `name leg failed: ${msg}`);
    }
  };
}

function loadSolanaSecret(): Uint8Array | undefined {
  const raw = process.env.LADING_SOLANA_KEYPAIR;
  if (!raw) return undefined;
  const text = raw.trim().startsWith('[') ? raw : readFileSync(raw, 'utf8');
  return Uint8Array.from(JSON.parse(text) as number[]);
}

async function main() {
  const doors: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<unknown>> = {};
  const describeDoors: Record<string, Record<string, unknown>> = {};

  const evmKey = process.env.LADING_EVM_PRIVATE_KEY as `0x${string}` | undefined;
  let ledger: Ledger | undefined;
  if (evmKey) {
    const uploader = lighthouseUploader(evmKey);
    const float = walrusFloat(evmKey);
    ledger = openLedger(DATA_DIR);
    console.log(ledger.path ? `walrus ledger ${ledger.path}: ${ledger.list().length} records` : 'LADING_DATA_DIR unset: the walrus ledger is in memory only');
    doors['/walrus'] = walrusDoor(uploader, ledger);
    doors['/walrus/quote'] = walrusQuoteDoor(uploader, float);
    doors['/walrus/renew'] = walrusRenewDoor(uploader, ledger);
    doors['/walrus/renew/quote'] = walrusRenewQuoteDoor(uploader, float, ledger);
    describeDoors.walrusRenewQuote = {
      path: '/walrus/renew/quote',
      answers: 'WalrusRenewQuote: deliverable, current paid-through date, downstream USDC price, float',
      input: 'params op=walrus-renew, phase=quote, lighthouseId (from the walrus leg proof) or blobId',
      floatAddress: float.address,
    };
    describeDoors.walrusRenew = {
      path: '/walrus/renew',
      network: 'walrus',
      provider: 'lighthouse-x402',
      extends: 'P365D',
      renewer: uploader.address,
      note: 'Lighthouse lets only the paying wallet renew; that is this address for every record sold through /walrus',
      input: 'params op=walrus-renew, lighthouseId or blobId',
    };
    describeDoors.walrusQuote = {
      path: '/walrus/quote',
      answers: 'WalrusQuote: deliverable, downstream USDC price, float',
      input: 'params op=walrus, phase=quote, size (bytes); or the blob itself',
      floatAddress: float.address,
    };
    describeDoors.walrus = {
      path: '/walrus',
      network: 'walrus',
      provider: 'lighthouse-x402',
      endpoint: LIGHTHOUSE_X402,
      aggregator: WALRUS_AGGREGATOR,
      retention: 'P365D',
      maxBytes: MAX_BODY_BYTES,
      input: "['i', base64, 'blob'], optional param name",
    };
  } else {
    console.log('LADING_EVM_PRIVATE_KEY unset: the walrus door is OFF');
  }

  const filecoinKey = process.env.LADING_FILECOIN_PRIVATE_KEY as `0x${string}` | undefined;
  if (filecoinKey) {
    const chain = filecoinChain(process.env.LADING_FILECOIN_CHAIN);
    const copies = Number(process.env.LADING_FILECOIN_COPIES ?? 2);
    const uploader = synapseUploader({ privateKey: filecoinKey, chain, copies, source: 'lading', maxBytes: MAX_BODY_BYTES });
    // One conservative answer (priced at the packet cap) per FLOAT_CACHE_MS, however many quotes arrive.
    const info = cached(FLOAT_CACHE_MS, () => uploader.quote(MAX_BODY_BYTES));
    doors['/filecoin'] = filecoinDoor(uploader);
    doors['/filecoin/quote'] = filecoinQuoteDoor(uploader, info);
    describeDoors.filecoinQuote = {
      path: '/filecoin/quote',
      answers: 'FilecoinQuote: deliverable, add-piece fee, USDFC float and runway',
      input: 'params op=filecoin, phase=quote, size (bytes); or the blob itself',
      floatAddress: uploader.address,
      minRunwayDays: FILECOIN_MIN_RUNWAY_DAYS.toString(),
    };
    describeDoors.filecoin = {
      path: '/filecoin',
      network: 'filecoin',
      provider: 'filecoin-onchain-cloud',
      chain: `filecoin:${chain.id}`,
      copies,
      retention: 'per-epoch',
      minBytes: FILECOIN_MIN_BYTES,
      maxBytes: MAX_BODY_BYTES,
      input: "['i', base64, 'blob'], optional param name",
    };
  } else {
    console.log('LADING_FILECOIN_PRIVATE_KEY unset: the filecoin door is OFF');
  }

  const antId = process.env.LADING_ANT_ID;
  const baseName = process.env.LADING_ARNS_BASE_NAME;
  const solanaSecret = loadSolanaSecret();
  if (antId && baseName && solanaSecret) {
    const namer = await solanaNamer({
      antId,
      baseName,
      gateway: process.env.LADING_ARNS_GATEWAY ?? 'permagate.io',
      secretKey: solanaSecret,
      rpcUrl: process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com',
    });
    const rpcUrl = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
    const rpc = createSolanaRpc(rpcUrl);
    const lamports = cached(FLOAT_CACHE_MS, async () => BigInt((await rpc.getBalance(solAddress(namer.signerAddress)).send()).value));
    doors['/name'] = nameDoor(namer);
    doors['/name/quote'] = nameQuoteDoor(namer, lamports);
    describeDoors.nameQuote = {
      path: '/name/quote',
      answers: 'NameQuote: deliverable, undername, float in lamports',
      input: 'params op=name, phase=quote, and undername or sha256; optional txid',
      floatAddress: namer.signerAddress,
      needLamports: NAME_NEED_LAMPORTS.toString(),
    };
    describeDoors.name = {
      path: '/name',
      antId,
      baseName,
      gateway: namer.gateway,
      input: 'params op=name, txid, and undername or sha256',
    };
  } else {
    console.log('LADING_ANT_ID / LADING_ARNS_BASE_NAME / LADING_SOLANA_KEYPAIR not all set: the name door is OFF');
  }

  const nodeSecret = process.env.LADING_NODE_SECRET;
  const nodePubkey = nodeSecret ? getPublicKey(Uint8Array.from(Buffer.from(nodeSecret, 'hex'))) : undefined;

  const describe = {
    version: VERSION,
    app: 'lading',
    ...(nodePubkey ? { nodePubkey } : {}),
    transport: {
      protocol: 'nip90-over-ilp',
      inputEncoding: 'i-tags and param-tags',
      resultDelivery: 'ilp-fulfill-body',
      refusals: 'reject-before-receipt',
      quotes: 'a quote door per leg answers deliverability before the leg is paid',
      handlerPaths: Object.fromEntries(Object.entries(describeDoors).map(([k, v]) => [k, v.path])),
    },
    handlerKinds: Object.keys(doors).length ? [LEG_KIND] : [],
    manifestKind: MANIFEST_KIND,
    doors: describeDoors,
    legsElsewhere: {
      arweave: 'the org store route (kind:5094), not this process',
      relay: 'the node relay write route, not this process',
    },
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, doors: Object.keys(doors), devMode: DEV_MODE });
      if (req.method === 'GET' && req.url === '/describe') return send(res, 200, describe);
      if (req.method === 'GET' && req.url === '/walrus/ledger') {
        if (!ledger) return refuse(res, 404, 'F00', 'the walrus door is OFF');
        const now = Date.now();
        return send(res, 200, { records: ledger.list().map((r) => ({ ...r, daysLeft: daysLeft(r.expiresAt, now) })), path: ledger.path ?? null, at: Math.floor(now / 1000) });
      }
      const door = req.method === 'POST' && req.url ? doors[req.url] : undefined;
      if (door) return await door(req, res);
      return refuse(res, 404, 'F00', 'not found');
    } catch (e) {
      console.error('unhandled', e);
      if (!res.headersSent) return refuse(res, 502, 'T00', (e as Error).message);
    }
  });
  server.listen(PORT, () => console.log(`lading ${VERSION} on :${PORT} doors=${Object.keys(doors).join(',') || 'none'} devMode=${DEV_MODE}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
