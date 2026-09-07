/**
 * The gate: Lading hosted, behind an x402 door.
 *
 * A caller that does not speak ILP (Claude through the MCP shim in mcp.ts, or
 * any HTTP client with a Base USDC key) pays this door once per call. Every
 * hop past it is ILP through the edge, paid by the gate's own TOON payer, the
 * same lib.ts code the CLI runs. x402 is the ingress at the boundary with
 * something that does not speak ILP; TOON is the inside.
 *
 *   GET  /health
 *   GET  /v1/describe             what this gate sells, the payer, the prices; free
 *   GET  /v1/quote?size=N         the door price for an object of N bytes; free
 *   POST /v1/put                  octet-stream body, x-file-name, x-mime; x402 priced per request
 *   GET  /v1/renew/quote?id=      the door price for one more year on a Lighthouse record; free
 *   POST /v1/renew                JSON {lighthouseId}; x402, flat
 *   GET  /v1/verify?ref=          re-fetch every leg of a manifest and compare sha256; free
 *
 * Settlement runs after the handler answers 2xx (the middleware buffers the
 * response), so a put that fails is not charged to the caller; the gate eats
 * the route prices it already paid, bounded by the quote doors. That is the
 * margin's job. GATE_FREE=1 runs the same doors with no payment, for a local
 * check against a funded payer.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { basename } from 'node:path';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { privateKeyToAccount } from 'viem/accounts';
import { Lading, optionsFromEnv, sha256, type Estimate } from './lib.js';
import { DEFAULT_PART_BYTES } from './parts.js';
import { gatePriceMicro, gatePriceUsdc, microToUsdc, pricingFromEnv } from './gate-price.js';

const VERSION = '0.6.0';
const PORT = Number(process.env.PORT ?? 3601);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 3 * 1024 * 1024);
const FREE = process.env.GATE_FREE === '1';
const NETWORK = (process.env.X402_NETWORK ?? 'eip155:8453') as `${string}:${string}`;
const FACILITATOR = process.env.X402_FACILITATOR ?? 'https://facilitator.payai.network';
/** Where the x402 revenue lands. Defaults to the Walrus float key's address when that key is in the environment, so revenue refills the float. */
const PAY_TO =
  process.env.LADING_GATE_PAYTO ??
  (process.env.LADING_EVM_PRIVATE_KEY ? privateKeyToAccount(process.env.LADING_EVM_PRIVATE_KEY as `0x${string}`).address : undefined);
const PUBLIC_URL = process.env.LADING_GATE_URL ?? `http://127.0.0.1:${PORT}`;
const pricing = pricingFromEnv();

if (!FREE && !PAY_TO) {
  console.error('gate: set LADING_GATE_PAYTO (Base address for revenue) or LADING_EVM_PRIVATE_KEY, or GATE_FREE=1 for a free door');
  process.exit(2);
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), 'gate', ...a);
const lading = new Lading(optionsFromEnv({ log: (line) => log(line) }));

/** One TOON job at a time: the payer's channel is a single nonce stream, and two puts of the same bytes would share a progress file. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

const partBytesOf = (raw: unknown) => {
  const n = raw === undefined ? DEFAULT_PART_BYTES : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `part-bytes must be a positive integer, got ${raw}`);
  return n;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The bill for a put of `size` bytes and the door price on top, both as numbers a caller can check. */
async function quotePut(size: number, partBytes: number) {
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive integer');
  if (size > MAX_BODY_BYTES) throw new HttpError(413, `size over the ${MAX_BODY_BYTES} byte ceiling`);
  const est: Estimate = await lading.estimate(size, partBytes);
  if (est.unpriced.length) throw new HttpError(503, `edge did not price ${est.unpriced.join(', ')}`);
  const price = gatePriceMicro(est.total, pricing);
  return {
    size,
    parts: est.parts,
    partBytes,
    toon: { units: est.total.toString(), usdc: microToUsdc(est.total), rows: est.rows.map((r) => ({ leg: r.leg, route: r.route, units: r.price?.toString() ?? null, note: r.note })) },
    price: { usdc: microToUsdc(price), network: NETWORK, payTo: PAY_TO ?? null, margin: pricing.margin, floorUsdc: pricing.floorUsdc },
  };
}

/** The bill for one renewal: the renew route and its quote door, nothing size-dependent. */
async function quoteRenew() {
  const R = lading.opts.routes;
  const renew = await lading.charge(R.walrusRenew, 0);
  const quote = await lading.charge(R.walrusRenewQuote, 0);
  if (renew === null || quote === null) throw new HttpError(503, 'edge did not price the renew doors');
  const units = renew + quote;
  return { toon: { units: units.toString(), usdc: microToUsdc(units) }, price: { usdc: gatePriceUsdc(units, pricing), network: NETWORK, payTo: PAY_TO ?? null } };
}

/** Who signed the x402 payment on this request, when it carried one. Best effort: the manifest records it, nothing depends on it. */
function payerOf(req: Request): string | undefined {
  const h = req.get('payment-signature') ?? req.get('x-payment');
  if (!h) return undefined;
  try {
    const p = decodePaymentSignatureHeader(h) as { payload?: { authorization?: { from?: unknown }; from?: unknown } };
    const from = p.payload?.authorization?.from ?? p.payload?.from;
    return typeof from === 'string' ? from : undefined;
  } catch {
    return undefined;
  }
}

const app = express();
app.disable('x-powered-by');

// A put is priced on its declared length, so it has to declare one, and it has to fit.
app.post('/v1/put', (req, res, next) => {
  const len = req.get('content-length');
  if (!len || !/^\d+$/.test(len)) return res.status(411).json({ error: 'content-length required: the door is priced on it' });
  if (Number(len) > MAX_BODY_BYTES) return res.status(413).json({ error: `body over the ${MAX_BODY_BYTES} byte ceiling` });
  if (Number(len) === 0) return res.status(400).json({ error: 'empty body' });
  return next();
});

if (!FREE) {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
  const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        'POST /v1/put': {
          accepts: {
            scheme: 'exact',
            network: NETWORK,
            payTo: PAY_TO!,
            maxTimeoutSeconds: 900,
            price: async (ctx) => {
              const size = Number(ctx.adapter.getHeader('content-length'));
              const q = await quotePut(size, partBytesOf(ctx.adapter.getHeader('x-part-bytes') || undefined));
              return q.price.usdc;
            },
          },
          description: 'Lading put: the bytes onto Arweave, Walrus and Filecoin, a signed bill of lading on Arweave, named on ArNS. Priced on content-length.',
          mimeType: 'application/json',
          serviceName: 'lading',
        },
        'POST /v1/renew': {
          accepts: {
            scheme: 'exact',
            network: NETWORK,
            payTo: PAY_TO!,
            maxTimeoutSeconds: 600,
            price: async () => (await quoteRenew()).price.usdc,
          },
          description: 'Lading renew: one more year on Walrus for a record this broker paid Lighthouse for.',
          mimeType: 'application/json',
          serviceName: 'lading',
        },
      },
      server,
    ),
  );
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, free: FREE, edge: lading.opts.edge, network: NETWORK, payTo: PAY_TO ?? null, facilitator: FREE ? null : FACILITATOR });
});

app.get('/v1/describe', async (_req, res, next) => {
  try {
    const routes = await lading.describe();
    res.json({
      service: 'lading',
      version: VERSION,
      what: 'Archive broker on TOON: one call, three storage networks, a signed bill of lading named on ArNS. Pay this door with USDC on Base over x402; every hop behind it is ILP.',
      door: { url: PUBLIC_URL, network: NETWORK, payTo: PAY_TO ?? null, facilitator: FREE ? null : FACILITATOR, free: FREE, margin: pricing.margin, floorUsdc: pricing.floorUsdc, maxBodyBytes: MAX_BODY_BYTES },
      edge: lading.opts.edge,
      payer: { nostrPubkey: lading.payerPubkey() },
      routes: routes.map((r) => ({ key: r.key, route: r.route, units: r.price?.toString() ?? null })),
      install: `claude mcp add lading -e LADING_X402_KEY=0x… -- npx -y lading mcp --gate ${PUBLIC_URL}`,
      endpoints: ['GET /v1/quote?size=N', 'POST /v1/put', 'GET /v1/renew/quote?id=', 'POST /v1/renew', 'GET /v1/verify?ref='],
    });
  } catch (e) {
    next(e);
  }
});

app.get('/v1/quote', async (req, res, next) => {
  try {
    res.json(await quotePut(Number(req.query.size), partBytesOf(req.query['part-bytes'])));
  } catch (e) {
    next(e);
  }
});

app.get('/v1/renew/quote', async (req, res, next) => {
  try {
    const id = String(req.query.id ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, 'id must be a Lighthouse record id');
    const q = await quoteRenew();
    // Lighthouse's public price endpoint: today's paid-through date for the record, free.
    const r = await fetch(`${lading.opts.lighthouseX402}/api/renew/price?id=${encodeURIComponent(id)}`);
    const record = r.status === 404 ? null : r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
    res.json({ lighthouseId: id, ...q, record: record === undefined ? { error: `lighthouse ${r.status}` } : record });
  } catch (e) {
    next(e);
  }
});

app.get('/v1/verify', async (req, res, next) => {
  try {
    const ref = String(req.query.ref ?? '');
    if (!ref || ref.includes('/') && !ref.startsWith('http')) throw new HttpError(400, 'ref must be an ArNS name, a manifest txid, or a manifest URL');
    const v = await lading.verify(ref);
    res.json({ ok: v.ok, pubkey: v.pubkey, sha256: v.sha256, size: v.size, legs: v.legs, rows: v.rows, manifest: v.manifest });
  } catch (e) {
    next(e);
  }
});

app.post('/v1/put', express.raw({ type: () => true, limit: MAX_BODY_BYTES }), async (req, res, next) => {
  try {
    const bytes = new Uint8Array(req.body as Buffer);
    if (bytes.length === 0) throw new HttpError(400, 'empty body');
    const sha = sha256(bytes);
    const rawName = req.get('x-file-name');
    const name = rawName ? basename(decodeURIComponent(rawName)).slice(0, 200) || `object-${sha.slice(0, 12)}` : `object-${sha.slice(0, 12)}`;
    const mime = req.get('x-mime') || req.get('content-type') || undefined;
    const partBytes = partBytesOf(req.get('x-part-bytes') || undefined);
    const payer = payerOf(req);
    const quoted = await quotePut(bytes.length, partBytes);
    log(`put ${sha.slice(0, 12)} ${bytes.length} B "${name}" payer=${payer ?? (FREE ? 'free' : '?')} price=${quoted.price.usdc} USDC toon=${quoted.toon.units}`);
    const r = await serialize(() =>
      lading.put(bytes, {
        name,
        mime: mime === 'application/octet-stream' ? undefined : mime,
        partBytes,
        via: { door: 'x402', network: NETWORK, ...(payer ? { payer } : {}) },
      }),
    );
    log(`put ${sha.slice(0, 12)} done: ${r.legs.map((l) => l.network).join('+')} manifest=${r.manifestTxId ?? '-'} name=${r.name?.name ?? '-'} paid=${r.total}`);
    res.json({
      sha256: r.sha256,
      size: r.size,
      parts: r.parts,
      legs: r.legs,
      manifest: r.manifest,
      manifestTxId: r.manifestTxId ?? null,
      manifestUrl: r.manifestUrl ?? null,
      name: r.name ?? null,
      paid: r.paid.map((p) => ({ leg: p.leg, route: p.route, units: p.price?.toString() ?? null })),
      toon: { units: r.total.toString(), usdc: microToUsdc(r.total) },
      price: quoted.price,
      via: { door: 'x402', network: NETWORK, payer: payer ?? null },
    });
  } catch (e) {
    next(e);
  }
});

app.post('/v1/renew', express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    const id = String((req.body as { lighthouseId?: unknown })?.lighthouseId ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, 'lighthouseId must be a Lighthouse record id');
    const payer = payerOf(req);
    log(`renew ${id} payer=${payer ?? (FREE ? 'free' : '?')}`);
    const r = await serialize(() => lading.renew(id));
    const row = r.rows[0];
    if (!row || row.skipped) throw new HttpError(409, `not renewable right now: ${row?.skipped ?? 'no record'}`);
    log(`renew ${id} done: ${row.previousExpiresAt} -> ${row.expiresAt} paid=${r.total}`);
    res.json({ ...row, toon: { units: r.total.toString(), usdc: microToUsdc(r.total) }, via: { door: 'x402', network: NETWORK, payer: payer ?? null } });
  } catch (e) {
    next(e);
  }
});

app.use((_req, res) => res.status(404).json({ error: 'no such door' }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode ?? 502;
  const message = (err as Error)?.message ?? String(err);
  if (status >= 500) log(`error ${status}: ${message}`);
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  log(`lading gate ${VERSION} on :${PORT}${FREE ? ' FREE (no x402)' : ` x402 ${NETWORK} payTo=${PAY_TO} facilitator=${FACILITATOR}`} edge=${lading.opts.edge} margin=${pricing.margin} floor=${pricing.floorUsdc} maxBody=${MAX_BODY_BYTES}`);
});
// A chunked put runs for minutes; do not let Node cut the request off.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.timeout = 0;

const stop = async () => {
  server.close();
  await lading.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
