/**
 * Lading's handler: the doors a TOON connector terminates routes at.
 *
 *   POST /walrus   kind:5320, `['i', base64, 'blob']`  → WalrusReceipt
 *   POST /name     kind:5320, params op=name, txid, undername → NameReceipt
 *   GET  /describe what this node serves, derived from what booted
 *   GET  /health
 *
 * Payment is the connector's business: by the time a request lands here the
 * claim has been verified and the route's price charged. This process holds
 * no payment logic. It reads the ADR 0040 headers for the log line only.
 *
 * FULFILL (`accept: true`) is sent only once the downstream network handed
 * back its receipt; anything short of that is `accept: false` and the packet
 * is rejected, so no money moves for a failed upload. That is the whole point.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { LEG_KIND, MANIFEST_KIND } from './kinds.js';
import { lighthouseUploader, sha256Hex, LIGHTHOUSE_X402, WALRUS_AGGREGATOR, type WalrusUploader } from './walrus.js';
import { solanaNamer, undernameFor, UNDERNAME_RE, type Namer } from './arns.js';

const PORT = Number(process.env.PORT ?? 3600);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 3 * 1024 * 1024);
const DEV_MODE = process.env.DEV_MODE === '1';
const VERSION = '0.1.0';

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
async function openJob(req: IncomingMessage, res: ServerResponse, op: string) {
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
  return { event, meta };
}

function walrusDoor(uploader: WalrusUploader) {
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
  if (evmKey) {
    doors['/walrus'] = walrusDoor(lighthouseUploader(evmKey));
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
    doors['/name'] = nameDoor(namer);
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
