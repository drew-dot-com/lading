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
 *   GET  /v1/describe             what this gate sells, the payer, the prices, and `health`: every float
 *                                 behind this door judged against its low-water mark (refuel polls it); free
 *   GET  /v1/quote?size=N         the door price for an object of N bytes; free
 *   GET  /v1/manifest?sha=<hex>   the bill of lading this gate already holds for those bytes, or 404; free
 *   POST /v1/put                  octet-stream body, x-file-name, x-mime, x-sha256; x402 priced per request.
 *                                 A declared sha this gate already archived is answered from the saved
 *                                 record at the floor price, no leg re-bought (idempotent put).
 *   GET  /v1/quote/parts?size=N   the multipart bill: the plan, a price per part, the finish price, the total; free
 *   GET  /v1/parts?sha=<hex>      which parts of an object this gate already bought, per network; free
 *   POST /v1/parts                one slice (x-object-sha256, x-object-size, x-part-index, x-part-count,
 *                                 x-part-bytes, x-sha256); x402 priced on the slice; a slice already bought
 *                                 on arweave and walrus is answered at the floor
 *   POST /v1/assemble             JSON {sha256, size, partCount, partBytes, name, mime, skip}; x402 priced on
 *                                 the finish (relay, manifest, name); 409 lists parts still missing
 *   GET  /v1/renew/quote?id=      the door price for one more year on a Lighthouse record; free
 *   POST /v1/renew                JSON {lighthouseId}; x402, flat
 *   GET  /v1/verify?ref=          re-fetch every leg of a manifest and compare sha256; free
 *   GET  /v1/credit?pubkey=       a Nostr pubkey's upload credit; free
 *   POST /v1/credit               x-pubkey, x-usdc; x402 priced at x-usdc: credit for that pubkey's Blossom uploads
 *   Blossom (docs/blossom.md), at the root: HEAD/PUT /upload, PUT /mirror, GET/HEAD /<sha256>[.ext], DELETE
 *                                 (refused); a kind 24242 Authorization; uploads are priced like a put and
 *                                 paid from the pubkey's credit
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
import { existsSync, readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { InputError, Lading, PartsMissingError, optionsFromEnv, sha256, type Estimate, type PutResult } from './lib.js';
import { judge, lamportsToSol, microToDecimal, report, solanaHoldings, type FloatRow, type FloatsReport } from './floats.js';
import { cached } from './quote.js';
import { DEFAULT_PART_BYTES, planParts } from './parts.js';
import { gatePriceMicro, gatePriceUsdc, microToUsdc, pricingFromEnv, usdcToMicro } from './gate-price.js';

import { VERSION } from './version.js';
import { installLongFetch } from './long-fetch.js';
import { BlossomError, CreditLedger, blossomErrorHandler, blossomRouter, npubOf, type BlobRecord } from './blossom.js';
import { parseManifest } from './manifest.js';
import { readFirst } from './read.js';
import { join } from 'node:path';
installLongFetch();
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
/** The broker whose float rows this gate republishes under `health`; unset = only the gate's own payer is reported. */
const BROKER_URL = process.env.LADING_BROKER_URL;
/** The payer must hold a channel deposit's worth of USDC so the client can open the next channel, and enough SOL for its rent and fees. */
const GATE_LOW_USDC = process.env.LADING_GATE_LOW_USDC ?? microToDecimal(BigInt(process.env.LADING_CHANNEL_DEPOSIT ?? '2000000'));
const GATE_LOW_SOL = process.env.LADING_GATE_LOW_SOL ?? '0.01';
/** Progress files for objects whose parts were bought but never assembled are dropped after this long. */
const PROGRESS_MAX_AGE_MS = Number(process.env.LADING_PROGRESS_MAX_AGE_DAYS ?? 7) * 86_400_000;

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

/** The gate's TOON payer address, derived once on first use (a bad key then fails the doors that need it, not the boot). */
let payerAddressOnce: Promise<string> | undefined;
const payerAddress = () =>
  (payerAddressOnce ??= (async () => {
    const secret = lading.opts.solanaSecret ?? Uint8Array.from(JSON.parse(readFileSync(lading.opts.solanaKeypair, 'utf8')) as number[]);
    return (await createKeyPairSignerFromBytes(secret)).address;
  })().catch((e: Error) => {
    payerAddressOnce = undefined;
    throw e;
  }));

/**
 * The open channel as the client tracks it, deposit read on chain: headroom is
 * what is left before the next job has to top the deposit up (lib does that
 * by itself, one deposit's worth at a time, from this payer's USDC).
 */
async function channelHeadroom(): Promise<Record<string, string | number | null>> {
  try {
    const s = await lading.channelState();
    if (!s) return { channel: null };
    return { channel: s.channelId, nonce: s.nonce, usedUnits: s.spent.toString(), depositUnits: s.deposit.toString(), headroomUnits: s.available.toString() };
  } catch (e) {
    return { channel: `unreadable: ${(e as Error).message.slice(0, 80)}` };
  }
}

/** The gate's own two floats, read together and cached: one RPC round per 30 s however often describe is hit. */
const payerFloats = cached(30_000, async (): Promise<FloatRow[]> => {
  const owner = await payerAddress();
  const h = await solanaHoldings(lading.opts.solanaRpc, owner);
  return [
    judge({
      name: 'gate-payer-usdc',
      role: 'the gate\'s TOON payer: USDC locked as each channel deposit, spent per leg as off-chain claims',
      chain: 'solana',
      asset: 'USDC',
      address: owner,
      balance: microToDecimal(h.usdcMicro),
      low: GATE_LOW_USDC,
      fund: `Send USDC (SPL) on Solana to ${owner}.`,
      extra: await channelHeadroom(),
    }),
    judge({
      name: 'gate-payer-sol',
      role: 'rent and fees for the gate payer\'s channel opens and settlements',
      chain: 'solana',
      asset: 'SOL',
      address: owner,
      balance: lamportsToSol(h.lamports),
      low: GATE_LOW_SOL,
      fund: `Send SOL to ${owner}.`,
    }),
  ];
});

/** The broker's rows, fetched fresh: it caches its own reads. Unreachable = one row that is not ok. */
async function brokerFloats(): Promise<FloatRow[]> {
  if (!BROKER_URL) return [];
  try {
    const r = await fetch(`${BROKER_URL.replace(/\/+$/, '')}/floats`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`broker answered ${r.status}`);
    return ((await r.json()) as FloatsReport).floats;
  } catch (e) {
    return [{ name: 'broker', role: 'the broker behind this gate (walrus, filecoin, name doors)', chain: '?', asset: '?', address: BROKER_URL, balance: '?', low: '?', ok: false, fund: `broker unreachable: ${(e as Error).message.slice(0, 120)}` }];
  }
}

/** Every float behind this door. */
async function health(): Promise<FloatsReport> {
  const [mine, theirs] = await Promise.all([
    payerFloats().catch((e: Error) => [{ name: 'gate-payer', role: 'the gate\'s TOON payer', chain: 'solana', asset: '?', address: '?', balance: '?', low: '?', ok: false, fund: `read failed: ${e.message.slice(0, 120)}` }] as FloatRow[]),
    brokerFloats(),
  ]);
  return report([...mine, ...theirs]);
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

const SHA_RE = /^[0-9a-f]{64}$/;
/** A declared object hash, lower-cased, or undefined when the caller declared none. */
function declaredSha(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const sha = raw.trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new HttpError(400, 'x-sha256 must be 64 hex characters');
  return sha;
}

/** The floor as the door quotes it: the same six-decimal string every other price uses. */
const floorUsdc = () => microToUsdc(usdcToMicro(pricing.floorUsdc));

/**
 * The bill for a put of `size` bytes and the door price on top, both as
 * numbers a caller can check. With a `sha` this gate already archived the
 * price is the floor: the record is handed back, no leg is bought.
 */
async function quotePut(size: number, partBytes: number, sha?: string) {
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive integer');
  if (size > MAX_BODY_BYTES) throw new HttpError(413, `size over the ${MAX_BODY_BYTES} byte ceiling`);
  const prior = sha ? lading.archived(sha) : undefined;
  if (prior) {
    return {
      size,
      parts: prior.parts,
      partBytes,
      reused: true,
      existing: { manifestTxId: prior.manifestTxId, manifestUrl: prior.manifestUrl, name: prior.name?.name ?? null, archivedAt: prior.archivedAt },
      toon: { units: '0', usdc: microToUsdc(0n), rows: [] },
      price: { usdc: floorUsdc(), network: NETWORK, payTo: PAY_TO ?? null, margin: pricing.margin, floorUsdc: pricing.floorUsdc },
    };
  }
  const est: Estimate = await lading.estimate(size, partBytes);
  if (est.unpriced.length) throw new HttpError(503, `edge did not price ${est.unpriced.join(', ')}`);
  const price = gatePriceMicro(est.total, pricing);
  return {
    size,
    parts: est.parts,
    partBytes,
    reused: false,
    toon: { units: est.total.toString(), usdc: microToUsdc(est.total), rows: est.rows.map((r) => ({ leg: r.leg, route: r.route, units: r.price?.toString() ?? null, note: r.note })) },
    price: { usdc: microToUsdc(price), network: NETWORK, payTo: PAY_TO ?? null, margin: pricing.margin, floorUsdc: pricing.floorUsdc },
  };
}

/** The bill of lading as every door answers it, for a fresh put and a reused one alike. */
function putBody(r: PutResult, extra: Record<string, unknown> = {}) {
  return {
    sha256: r.sha256,
    size: r.size,
    parts: r.parts,
    reused: r.reused ?? false,
    archivedAt: r.archivedAt,
    legs: r.legs,
    manifest: r.manifest,
    manifestTxId: r.manifestTxId ?? null,
    manifestUrl: r.manifestUrl ?? null,
    name: r.name ?? null,
    paid: r.paid.map((p) => ({ leg: p.leg, route: p.route, units: p.price?.toString() ?? null })),
    toon: { units: r.total.toString(), usdc: microToUsdc(r.total) },
    ...extra,
  };
}

/** The door price for a bill: margin and floor. */
const doorPrice = (est: Estimate, what: string) => {
  if (est.unpriced.length) throw new HttpError(503, `edge did not price ${est.unpriced.join(', ')} (${what})`);
  return microToUsdc(gatePriceMicro(est.total, pricing));
};
const priceBlock = (usdc: string) => ({ usdc, network: NETWORK, payTo: PAY_TO ?? null, margin: pricing.margin, floorUsdc: pricing.floorUsdc });
const toonBlock = (est: Estimate) => ({ units: est.total.toString(), usdc: microToUsdc(est.total), rows: est.rows.map((r) => ({ leg: r.leg, route: r.route, units: r.price?.toString() ?? null, note: r.note })) });

/** One slice: the four legs and their quote doors for that many bytes. Known on arweave and walrus already: the floor. */
async function quotePart(size: number, known: boolean) {
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive integer');
  if (size > MAX_BODY_BYTES) throw new HttpError(413, `part over the ${MAX_BODY_BYTES} byte ceiling`);
  if (known) return { size, reused: true, toon: { units: '0', usdc: microToUsdc(0n), rows: [] }, price: priceBlock(floorUsdc()) };
  const est = await lading.estimatePart(size);
  return { size, reused: false, toon: toonBlock(est), price: priceBlock(doorPrice(est, 'part')) };
}

/** The finish of an object in `n` parts: relay copy, manifest, name. Already archived: the floor. */
async function quoteFinish(n: number, sha?: string) {
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'part count must be a positive integer');
  if (sha && lading.archived(sha)) return { parts: n, reused: true, toon: { units: '0', usdc: microToUsdc(0n), rows: [] }, price: priceBlock(floorUsdc()) };
  const est = await lading.estimateFinish(n);
  return { parts: n, reused: false, toon: toonBlock(est), price: priceBlock(doorPrice(est, 'finish')) };
}

/** The whole multipart bill for an object of `size` bytes: the plan, a price per part, the finish, the sum. */
async function quoteParts(size: number, partBytes: number, sha?: string) {
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive integer');
  const plan = planParts(size, partBytes);
  const status = sha ? lading.partsStatus(sha) : undefined;
  const parts = [];
  let total = 0n;
  for (const p of plan) {
    // Known here means: the status says both required networks hold this index (the door checks the slice's own hash when it arrives).
    const known = !!status && (status.archived || (['arweave', 'walrus'] as const).every((n) => status.networks[n]?.indexes.includes(p.index)));
    const q = await quotePart(p.size, known);
    parts.push({ index: p.index, size: p.size, reused: q.reused, price: q.price.usdc, toonUnits: q.toon.units });
    total += usdcToMicro(q.price.usdc);
  }
  const finish = await quoteFinish(plan.length, sha);
  total += usdcToMicro(finish.price.usdc);
  return {
    size,
    partBytes,
    parts: plan.length,
    plan: parts,
    finish: { reused: finish.reused, price: finish.price.usdc, toonUnits: finish.toon.units },
    total: { usdc: microToUsdc(total), network: NETWORK, payTo: PAY_TO ?? null, payments: plan.length + 1 },
    ...(status ? { status } : {}),
  };
}

const intHeader = (raw: string | undefined, what: string) => {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new HttpError(400, `${what} must be a non-negative integer`);
  return Number(raw);
};

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

// The bill of lading page lives under an ArNS name on another origin and asks
// the free read doors from the browser; nothing paid or stateful is exposed.
const CORS_FREE_GETS = new Set(['/v1/verify', '/v1/manifest', '/v1/describe', '/v1/quote', '/health']);
app.use((req, res, next) => {
  if (!CORS_FREE_GETS.has(req.path)) return next();
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// A put is priced on its declared length, so it has to declare one, and it has to fit.
app.post('/v1/put', (req, res, next) => {
  const len = req.get('content-length');
  if (!len || !/^\d+$/.test(len)) return res.status(411).json({ error: 'content-length required: the door is priced on it' });
  if (Number(len) > MAX_BODY_BYTES) return res.status(413).json({ error: `body over the ${MAX_BODY_BYTES} byte ceiling` });
  if (Number(len) === 0) return res.status(400).json({ error: 'empty body' });
  return next();
});

app.post('/v1/parts', (req, res, next) => {
  const len = req.get('content-length');
  if (!len || !/^\d+$/.test(len)) return res.status(411).json({ error: 'content-length required: the door is priced on it' });
  if (Number(len) > MAX_BODY_BYTES) return res.status(413).json({ error: `part over the ${MAX_BODY_BYTES} byte ceiling` });
  if (Number(len) === 0) return res.status(400).json({ error: 'empty body' });
  return next();
});

// A credit top-up names the pubkey and the amount in headers so the x402 price is the amount.
const CREDIT_MIN_USDC = Number(process.env.LADING_CREDIT_MIN_USDC ?? 0.05);
const CREDIT_MAX_USDC = Number(process.env.LADING_CREDIT_MAX_USDC ?? 50);
const creditRequest = (get: (h: string) => string | undefined) => {
  const pubkey = (get('x-pubkey') ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new HttpError(400, 'x-pubkey header required: the hex Nostr pubkey to credit');
  const raw = get('x-usdc') ?? '';
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new HttpError(400, 'x-usdc header required: the amount to credit, up to 6 decimals');
  const usdc = Number(raw);
  if (usdc < CREDIT_MIN_USDC || usdc > CREDIT_MAX_USDC) throw new HttpError(400, `x-usdc must be between ${CREDIT_MIN_USDC} and ${CREDIT_MAX_USDC}`);
  return { pubkey, usdc: usdc.toFixed(6), micro: usdcToMicro(usdc.toFixed(6)) };
};
app.post('/v1/credit', (req, res, next) => {
  try {
    creditRequest((h) => req.get(h));
    return next();
  } catch (e) {
    return next(e);
  }
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
              const q = await quotePut(size, partBytesOf(ctx.adapter.getHeader('x-part-bytes') || undefined), declaredSha(ctx.adapter.getHeader('x-sha256') || undefined));
              return q.price.usdc;
            },
          },
          description: 'Lading put: the bytes onto Arweave, Walrus and Filecoin, a signed bill of lading on Arweave, named on ArNS. Priced on content-length; a declared x-sha256 this gate already archived is answered from the record at the floor price.',
          mimeType: 'application/json',
          serviceName: 'lading',
        },
        'POST /v1/parts': {
          accepts: {
            scheme: 'exact',
            network: NETWORK,
            payTo: PAY_TO!,
            maxTimeoutSeconds: 900,
            price: async (ctx) => {
              const size = Number(ctx.adapter.getHeader('content-length'));
              const sha = declaredSha(ctx.adapter.getHeader('x-object-sha256') || undefined);
              const partSha = declaredSha(ctx.adapter.getHeader('x-sha256') || undefined);
              const index = ctx.adapter.getHeader('x-part-index');
              const known = !!sha && !!partSha && index !== undefined && lading.partKnown(sha, Number(index), partSha);
              return (await quotePart(size, known)).price.usdc;
            },
          },
          description: 'Lading part: one slice of a larger object onto Arweave, Walrus and Filecoin, held until POST /v1/assemble. Priced on the slice; a slice this gate already bought is answered at the floor.',
          mimeType: 'application/json',
          serviceName: 'lading',
        },
        'POST /v1/assemble': {
          accepts: {
            scheme: 'exact',
            network: NETWORK,
            payTo: PAY_TO!,
            maxTimeoutSeconds: 600,
            price: async (ctx) => {
              const n = Number(ctx.adapter.getHeader('x-part-count') || 1);
              const sha = declaredSha(ctx.adapter.getHeader('x-object-sha256') || undefined);
              return (await quoteFinish(n, sha)).price.usdc;
            },
          },
          description: 'Lading assemble: seal the parts of an object into one bill of lading on Arweave, named on ArNS. Priced on the finish (relay copy, manifest, name).',
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
        'POST /v1/credit': {
          accepts: {
            scheme: 'exact',
            network: NETWORK,
            payTo: PAY_TO!,
            maxTimeoutSeconds: 300,
            price: async (ctx) => creditRequest((h) => ctx.adapter.getHeader(h) || undefined).usdc,
          },
          description: 'Lading credit: x-usdc of upload credit for the Nostr pubkey in x-pubkey. Blossom uploads (PUT /upload) from that key are priced like POST /v1/put and paid from it.',
          mimeType: 'application/json',
          serviceName: 'lading',
        },
      },
      server,
    ),
  );
}

app.get('/health', async (_req, res) => {
  const h = await health().catch(() => undefined);
  res.json({ ok: true, version: VERSION, free: FREE, edge: lading.opts.edge, network: NETWORK, payTo: PAY_TO ?? null, facilitator: FREE ? null : FACILITATOR, floats: h ? { ok: h.ok, low: h.low } : null });
});

/** The float rows alone, for anything that polls: the same object `describe` carries under `health`. */
app.get('/v1/floats', async (_req, res, next) => {
  try {
    res.json(await health());
  } catch (e) {
    next(e);
  }
});

app.get('/v1/describe', async (_req, res, next) => {
  try {
    const [routes, h] = await Promise.all([lading.describe(), health()]);
    res.json({
      service: 'lading',
      version: VERSION,
      what: 'Archive broker on TOON: one call, four storage networks (Arweave, Walrus, Filecoin, IPFS), a signed bill of lading named on ArNS. Pay this door with USDC on Base over x402; every hop behind it is ILP.',
      door: { url: PUBLIC_URL, network: NETWORK, payTo: PAY_TO ?? null, facilitator: FREE ? null : FACILITATOR, free: FREE, margin: pricing.margin, floorUsdc: pricing.floorUsdc, maxBodyBytes: MAX_BODY_BYTES },
      blossom: { server: PUBLIC_URL, upload: 'PUT /upload', preflight: 'HEAD /upload', mirror: 'PUT /mirror', read: 'GET /<sha256>.<ext>', credit: { read: 'GET /v1/credit?pubkey=', fund: 'POST /v1/credit (x-pubkey, x-usdc)', minUsdc: CREDIT_MIN_USDC, maxUsdc: CREDIT_MAX_USDC }, doc: 'https://github.com/drew-dot-com/lading/blob/main/docs/blossom.md' },
      edge: lading.opts.edge,
      read: { arns: lading.opts.gateway, arnsFallback: lading.arnsGateways(), txid: lading.readGateways() },
      payer: { nostrPubkey: lading.payerPubkey(), solana: await payerAddress().catch(() => null) },
      health: h,
      routes: routes.map((r) => ({ key: r.key, route: r.route, units: r.price?.toString() ?? null })),
      install: `claude mcp add lading -e LADING_X402_KEY=0x… -- npx -y lading mcp --gate ${PUBLIC_URL}`,
      endpoints: ['GET /v1/quote?size=N[&sha=]', 'GET /v1/manifest?sha=', 'POST /v1/put', 'GET /v1/quote/parts?size=N[&sha=]', 'GET /v1/parts?sha=', 'POST /v1/parts', 'POST /v1/assemble', 'GET /v1/renew/quote?id=', 'POST /v1/renew', 'GET /v1/verify?ref=', 'GET /v1/floats'],
      multipart: `Objects over ${MAX_BODY_BYTES} bytes go as parts of ${DEFAULT_PART_BYTES} bytes: one paid POST /v1/parts per slice (short request, small payment, settles on its own 2xx), then one paid POST /v1/assemble for the manifest and name. A slice already bought is answered at the floor; nothing is held in escrow.`,
      partBytes: DEFAULT_PART_BYTES,
      idempotent: 'POST /v1/put with x-sha256 set to a hash this gate already archived answers from the saved bill of lading at the floor price and buys no leg; GET /v1/manifest?sha= reads it free.',
    });
  } catch (e) {
    next(e);
  }
});

app.get('/v1/quote', async (req, res, next) => {
  try {
    res.json(await quotePut(Number(req.query.size), partBytesOf(req.query['part-bytes']), declaredSha(req.query.sha === undefined ? undefined : String(req.query.sha))));
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

app.get('/v1/quote/parts', async (req, res, next) => {
  try {
    res.json(await quoteParts(Number(req.query.size), partBytesOf(req.query['part-bytes']), declaredSha(req.query.sha === undefined ? undefined : String(req.query.sha))));
  } catch (e) {
    next(e);
  }
});

app.get('/v1/parts', (req, res, next) => {
  try {
    const sha = declaredSha(String(req.query.sha ?? ''));
    if (!sha) throw new HttpError(400, 'sha required');
    return res.json(lading.partsStatus(sha));
  } catch (e) {
    return next(e);
  }
});

app.get('/v1/manifest', (req, res, next) => {
  try {
    const sha = declaredSha(String(req.query.sha ?? ''));
    if (!sha) throw new HttpError(400, 'sha required');
    const prior = lading.archived(sha);
    if (!prior) return res.status(404).json({ error: 'not archived by this gate', sha256: sha });
    return res.json(putBody(prior, { via: parseVia(prior) }));
  } catch (e) {
    return next(e);
  }
});

/** The `via` a saved manifest recorded, when it came through a door. */
function parseVia(r: PutResult): unknown {
  try {
    return (JSON.parse(r.manifest.content) as { via?: unknown }).via ?? null;
  } catch {
    return null;
  }
}

app.get('/v1/verify', async (req, res, next) => {
  try {
    const ref = String(req.query.ref ?? '');
    if (!ref || ref.includes('/') && !ref.startsWith('http')) throw new HttpError(400, 'ref must be an ArNS name, a manifest txid, or a manifest URL');
    const v = await lading.verify(ref);
    res.json({ ok: v.ok, pubkey: v.pubkey, sha256: v.sha256, size: v.size, legs: v.legs, rows: v.rows, manifest: v.manifest, source: v.source });
  } catch (e) {
    next(e);
  }
});

app.post('/v1/put', express.raw({ type: () => true, limit: MAX_BODY_BYTES }), async (req, res, next) => {
  try {
    const bytes = new Uint8Array(req.body as Buffer);
    if (bytes.length === 0) throw new HttpError(400, 'empty body');
    const sha = sha256(bytes);
    const declared = declaredSha(req.get('x-sha256') || undefined);
    // The door was priced on the declared hash; the body has to be those bytes. Nothing settles on a 4xx.
    if (declared && declared !== sha) throw new HttpError(400, `x-sha256 ${declared.slice(0, 12)}… does not match the body (${sha.slice(0, 12)}…)`);
    const rawName = req.get('x-file-name');
    const name = rawName ? basename(decodeURIComponent(rawName)).slice(0, 200) || `object-${sha.slice(0, 12)}` : `object-${sha.slice(0, 12)}`;
    const mime = req.get('x-mime') || req.get('content-type') || undefined;
    const partBytes = partBytesOf(req.get('x-part-bytes') || undefined);
    const payer = payerOf(req);
    const prior = lading.archived(sha);
    if (prior && !declared && !FREE) {
      // Paid the full price for bytes this gate already holds. Answer without settling (4xx): the record is
      // free at /v1/manifest, and a repeat put that declares its hash is priced at the floor.
      log(`put ${sha.slice(0, 12)} ${bytes.length} B already archived, undeclared: 409, nothing settled`);
      return res.status(409).json({
        error: `already archived by this gate on ${new Date(prior.archivedAt * 1000).toISOString()}; nothing was charged. Read it free at GET /v1/manifest?sha=${sha}, or repeat the put with x-sha256: ${sha} to have it answered at the floor price.`,
        existing: putBody(prior, { via: parseVia(prior) }),
      });
    }
    const quoted = await quotePut(bytes.length, partBytes, declared);
    log(`put ${sha.slice(0, 12)} ${bytes.length} B "${name}" payer=${payer ?? (FREE ? 'free' : '?')} price=${quoted.price.usdc} USDC toon=${quoted.toon.units}${prior ? ' (already archived: reuse)' : ''}`);
    const r = await serialize(() =>
      lading.put(bytes, {
        name,
        mime: mime === 'application/octet-stream' ? undefined : mime,
        partBytes,
        via: { door: 'x402', network: NETWORK, ...(payer ? { payer } : {}) },
      }),
    );
    log(`put ${sha.slice(0, 12)} ${r.reused ? 'reused' : 'done'}: ${r.legs.map((l) => l.network).join('+')} manifest=${r.manifestTxId ?? '-'} name=${r.name?.name ?? '-'} paid=${r.reused ? 0 : r.total}`);
    return res.json(
      putBody(r, {
        price: quoted.price,
        via: r.reused ? parseVia(r) : { door: 'x402', network: NETWORK, payer: payer ?? null },
        ...(r.reused ? { thisCall: { door: 'x402', network: NETWORK, payer: payer ?? null, toonUnits: '0' } } : {}),
      }),
    );
  } catch (e) {
    return next(e);
  }
});

app.post('/v1/parts', express.raw({ type: () => true, limit: MAX_BODY_BYTES }), async (req, res, next) => {
  try {
    const bytes = new Uint8Array(req.body as Buffer);
    if (bytes.length === 0) throw new HttpError(400, 'empty body');
    const sha = declaredSha(req.get('x-object-sha256') || undefined);
    if (!sha) throw new HttpError(400, 'x-object-sha256 required: the sha256 of the whole object');
    const size = intHeader(req.get('x-object-size') || undefined, 'x-object-size');
    const index = intHeader(req.get('x-part-index') || undefined, 'x-part-index');
    const count = intHeader(req.get('x-part-count') || undefined, 'x-part-count');
    const partBytes = partBytesOf(req.get('x-part-bytes') || undefined);
    const partSha = sha256(bytes);
    const declared = declaredSha(req.get('x-sha256') || undefined);
    // The door was priced on the declared slice hash; the body has to be that slice. Nothing settles on a 4xx.
    if (declared && declared !== partSha) throw new HttpError(400, `x-sha256 ${declared.slice(0, 12)}… does not match the body (${partSha.slice(0, 12)}…)`);
    const rawName = req.get('x-file-name');
    const name = rawName ? basename(decodeURIComponent(rawName)).slice(0, 200) || `object-${sha.slice(0, 12)}` : `object-${sha.slice(0, 12)}`;
    const mime = req.get('x-mime') || undefined;
    const payer = payerOf(req);
    const known = !!declared && lading.partKnown(sha, index, declared);
    const quoted = await quotePart(bytes.length, known);
    log(`part ${sha.slice(0, 12)} ${index + 1}/${count} ${bytes.length} B "${name}" payer=${payer ?? (FREE ? 'free' : '?')} price=${quoted.price.usdc} USDC${known ? ' (already bought: reuse)' : ''}`);
    const r = await serialize(() => lading.putPart(bytes, { sha256: sha, size, index, count, partBytes, partSha256: partSha, name, mime: mime === 'application/octet-stream' ? undefined : mime }));
    log(`part ${sha.slice(0, 12)} ${index + 1}/${count} done: ${Object.keys(r.receipts).join('+') || 'nothing'}${r.missing.length ? ` missing ${r.missing.join(',')}` : ''} paid=${r.total}${r.archived ? ' (object already archived)' : ''}`);
    return res.json({
      sha256: r.sha256,
      size: r.size,
      index: r.index,
      count: r.count,
      part: r.part,
      archived: r.archived ?? false,
      receipts: r.receipts,
      missing: r.missing,
      paid: r.paid.map((p) => ({ leg: p.leg, route: p.route, units: p.price?.toString() ?? null })),
      toon: { units: r.total.toString(), usdc: microToUsdc(r.total) },
      price: quoted.price,
      status: lading.partsStatus(sha),
      via: { door: 'x402', network: NETWORK, payer: payer ?? null },
    });
  } catch (e) {
    return next(e);
  }
});

app.post('/v1/assemble', express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { sha256?: unknown; size?: unknown; partCount?: unknown; partBytes?: unknown; name?: unknown; mime?: unknown; skip?: unknown };
    const sha = declaredSha(typeof b.sha256 === 'string' ? b.sha256 : undefined);
    if (!sha) throw new HttpError(400, 'sha256 required');
    const size = Number(b.size);
    const count = Number(b.partCount);
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive integer');
    if (!Number.isInteger(count) || count <= 0) throw new HttpError(400, 'partCount must be a positive integer');
    const partBytes = partBytesOf(b.partBytes === undefined ? undefined : b.partBytes);
    const name = typeof b.name === 'string' && b.name ? basename(b.name).slice(0, 200) : `object-${sha.slice(0, 12)}`;
    const mime = typeof b.mime === 'string' && b.mime && b.mime !== 'application/octet-stream' ? b.mime : undefined;
    const skipList = Array.isArray(b.skip) ? (b.skip as unknown[]).filter((x): x is 'filecoin' | 'walrus' | 'ipfs' => x === 'filecoin' || x === 'walrus' || x === 'ipfs') : [];
    const skip = Object.fromEntries(skipList.map((k) => [k, true])) as Partial<Record<'filecoin' | 'walrus' | 'ipfs', boolean>>;
    const payer = payerOf(req);
    const quoted = await quoteFinish(count, sha);
    log(`assemble ${sha.slice(0, 12)} ${size} B in ${count} parts "${name}" payer=${payer ?? (FREE ? 'free' : '?')} price=${quoted.price.usdc} USDC${skipList.length ? ` skip=${skipList.join(',')}` : ''}`);
    const r = await serialize(() => lading.finish({ sha256: sha, size, count, partBytes, name, mime, skip, via: { door: 'x402', network: NETWORK, ...(payer ? { payer } : {}) } }));
    log(`assemble ${sha.slice(0, 12)} ${r.reused ? 'reused' : 'done'}: ${r.legs.map((l) => l.network).join('+')} manifest=${r.manifestTxId ?? '-'} name=${r.name?.name ?? '-'} paid=${r.reused ? 0 : r.total}`);
    return res.json(putBody(r, { price: quoted.price, via: r.reused ? parseVia(r) : { door: 'x402', network: NETWORK, payer: payer ?? null } }));
  } catch (e) {
    if (e instanceof PartsMissingError) return res.status(409).json({ error: e.message, sha256: e.sha256, missing: e.missing, status: lading.partsStatus(e.sha256) });
    return next(e);
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

// ---------------------------------------------------------------------------
// Blossom: credit per Nostr pubkey, and the BUD doors at the root of the host (docs/blossom.md).

const credit = new CreditLedger(join(lading.opts.home, 'blossom-credit.jsonl'));
for (const o of credit.orphanedDebits((sha) => !!lading.archived(sha))) {
  const left = credit.refund(o.pubkey, BigInt(o.micro), o.ref);
  log(`credit ${npubOf(o.pubkey).slice(0, 16)}… refunded ${microToUsdc(BigInt(o.micro))} USDC for ${o.ref.slice(0, 12)}… (debited ${new Date(o.at * 1000).toISOString()}, never archived) → ${microToUsdc(left)}`);
}

/** A Lading record in the shape the Blossom doors describe and serve. */
function blobRecord(r: PutResult): BlobRecord {
  let mime: string | undefined;
  try {
    mime = parseManifest(r.manifest).mime;
  } catch {
    mime = undefined;
  }
  return { sha256: r.sha256, size: r.size, mime, archivedAt: r.archivedAt, legs: r.legs, manifestUrl: r.manifestUrl, name: r.name?.name };
}

app.get('/v1/credit', (req, res, next) => {
  try {
    const pubkey = String(req.query.pubkey ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new HttpError(400, 'pubkey (hex) required');
    const micro = credit.balance(pubkey);
    return res.json({ pubkey, npub: npubOf(pubkey), credit: { usdc: microToUsdc(micro), micro: micro.toString() }, fund: { door: 'POST /v1/credit', headers: ['x-pubkey', 'x-usdc'], network: NETWORK, min: CREDIT_MIN_USDC, max: CREDIT_MAX_USDC }, history: credit.history(pubkey).slice(-20) });
  } catch (e) {
    return next(e);
  }
});

app.post('/v1/credit', (req, res, next) => {
  try {
    const { pubkey, usdc, micro } = creditRequest((h) => req.get(h));
    const payer = payerOf(req);
    const balance = credit.topUp(pubkey, micro, payer ?? (FREE ? 'free' : 'x402'));
    log(`credit ${npubOf(pubkey).slice(0, 16)}… +${usdc} USDC from ${payer ?? (FREE ? 'free' : '?')} → ${microToUsdc(balance)}`);
    return res.json({ pubkey, npub: npubOf(pubkey), credited: { usdc, micro: micro.toString() }, credit: { usdc: microToUsdc(balance), micro: balance.toString() }, payer: payer ?? null, blossom: { server: PUBLIC_URL, upload: 'PUT /upload', preflight: 'HEAD /upload' } });
  } catch (e) {
    return next(e);
  }
});

app.use(
  blossomRouter({
    baseUrl: PUBLIC_URL,
    maxBytes: MAX_BODY_BYTES,
    credit,
    price: async (size) => usdcToMicro((await quotePut(size, DEFAULT_PART_BYTES, undefined)).price.usdc),
    archived: (sha) => {
      const r = lading.archived(sha);
      return r ? blobRecord(r) : undefined;
    },
    put: async (bytes, o) => blobRecord(await serialize(() => lading.put(bytes, { name: o.name, mime: o.mime, partBytes: DEFAULT_PART_BYTES, via: { door: 'blossom', network: 'nostr', payer: o.pubkey } }))),
    readUrls: (leg) => lading.readUrlsFor(leg.network, leg.id, leg.proof),
    readFirst: (urls) => readFirst(urls),
    sha256,
    log,
  }),
);
app.use(blossomErrorHandler);

app.use((_req, res) => res.status(404).json({ error: 'no such door' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err instanceof BlossomError ? err.status : err instanceof InputError ? 400 : (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode ?? 502;
  const message = (err as Error)?.message ?? String(err);
  if (status >= 500) log(`error ${status}: ${message}`);
  res.status(status).json({ error: message });
});

const sweep = () => {
  try {
    const gone = lading.sweepProgress(PROGRESS_MAX_AGE_MS);
    if (gone.length) log(`swept ${gone.length} stale progress file(s): ${gone.map((f) => f.slice(0, 12)).join(', ')}`);
  } catch (e) {
    log(`sweep failed: ${(e as Error).message}`);
  }
};
sweep();
setInterval(sweep, 86_400_000).unref();

const server = app.listen(PORT, () => {
  log(`lading gate ${VERSION} on :${PORT}${FREE ? ' FREE (no x402)' : ` x402 ${NETWORK} payTo=${PAY_TO} facilitator=${FACILITATOR}`} edge=${lading.opts.edge} margin=${pricing.margin} floor=${pricing.floorUsdc} maxBody=${MAX_BODY_BYTES}`);
});
// A chunked put runs for minutes; do not let Node cut the request off.
// (2026-09-08: a client on a VPN saw every response slower than 60 s die; the
// same request from the box came back after 113 s. The tunnel drops idle TCP
// flows at 60 s, Node and Caddy were never the cause. A Blossom client on such
// a network cannot wait out a put; the parts doors are the answer for it.)
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
