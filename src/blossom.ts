/**
 * Blossom intake: BUD-01 (auth, GET/HEAD by hash, CORS), BUD-02 (PUT /upload,
 * the descriptor, DELETE), BUD-04 (PUT /mirror) and BUD-06 (HEAD /upload) at
 * the root of the gate host, so any Nostr client with the gate in its kind
 * 10063 server list uploads straight into a Lading put. Design and sources in
 * docs/blossom.md.
 *
 * No Blossom client can pay x402, so uploads draw on credit: a pubkey's balance
 * in micro-USDC, funded through the gate's `POST /v1/credit` x402 door and
 * debited at the same door price a `POST /v1/put` of that size would pay. A
 * refusal reaches the user only through `X-Reason`, so every 402 says the
 * balance, the price and where to fund.
 */
import { Router, raw, json, type Request, type Response, type NextFunction } from 'express';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

export const BLOSSOM_AUTH_KIND = 24242;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export class BlossomError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// BUD-01 auth

export type BlossomVerb = 'upload' | 'get' | 'delete' | 'list';

export interface BlossomAuth {
  pubkey: string;
  verbs: BlossomVerb[];
  /** Every `x` tag: the hashes the event authorises. */
  hashes: string[];
  event: NostrEvent;
}

function decodeAuthEvent(b64: string): NostrEvent {
  // Clients encode with btoa (standard base64); accept the url-safe alphabet too.
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const text = Buffer.from(std, 'base64').toString('utf8');
  try {
    return JSON.parse(text) as NostrEvent;
  } catch {
    throw new BlossomError(401, 'authorization event is not JSON');
  }
}

/**
 * Parses and checks an `Authorization: Nostr <base64 event>` header: kind
 * 24242, a valid signature, created in the past, an `expiration` tag in the
 * future, at least one `t` tag. What it is for (the verb, the hash) is the
 * door's check, see `requireVerb` and `requireHash`.
 */
export function parseAuthHeader(header: string | undefined, now = Math.floor(Date.now() / 1000)): BlossomAuth {
  if (!header) throw new BlossomError(401, 'Authorization: Nostr <base64 kind 24242 event> required');
  const m = /^Nostr\s+(\S+)$/i.exec(header.trim());
  if (!m) throw new BlossomError(401, 'authorization scheme must be Nostr');
  const ev = decodeAuthEvent(m[1]);
  if (ev.kind !== BLOSSOM_AUTH_KIND) throw new BlossomError(401, `authorization event kind must be ${BLOSSOM_AUTH_KIND}`);
  if (!Array.isArray(ev.tags)) throw new BlossomError(401, 'authorization event has no tags');
  if (!verifyEvent(ev)) throw new BlossomError(401, 'authorization event signature is invalid');
  if (typeof ev.created_at !== 'number' || ev.created_at > now + 60) throw new BlossomError(401, 'authorization event created_at must be in the past');
  const exp = ev.tags.find((t) => t[0] === 'expiration')?.[1];
  if (!exp || !/^\d+$/.test(exp)) throw new BlossomError(401, 'authorization event needs an expiration tag');
  if (Number(exp) <= now) throw new BlossomError(401, 'authorization event has expired');
  const verbs = ev.tags.filter((t) => t[0] === 't').map((t) => t[1]) as BlossomVerb[];
  if (verbs.length === 0) throw new BlossomError(401, 'authorization event needs a t tag');
  const hashes = ev.tags.filter((t) => t[0] === 'x').map((t) => (t[1] ?? '').toLowerCase());
  return { pubkey: ev.pubkey, verbs, hashes, event: ev };
}

export function requireVerb(auth: BlossomAuth, verb: BlossomVerb): void {
  if (!auth.verbs.includes(verb)) throw new BlossomError(403, `authorization event is for ${auth.verbs.join(', ')}, not ${verb}`);
}

export function requireHash(auth: BlossomAuth, sha: string): void {
  if (!auth.hashes.includes(sha)) throw new BlossomError(403, `authorization event does not name blob ${sha.slice(0, 12)}… in an x tag`);
}

// ---------------------------------------------------------------------------
// Credit ledger: micro-USDC per pubkey, append-only JSONL, replayed at boot.

export interface CreditRow {
  at: number;
  pubkey: string;
  kind: 'topup' | 'debit' | 'refund';
  /** Micro-USDC, always positive; the kind says the sign. */
  micro: string;
  /** What it was for: a Base tx or payer for a top-up, a blob hash for a debit or refund. */
  ref: string;
}

export class CreditLedger {
  private balances = new Map<string, bigint>();
  private rows: CreditRow[] = [];

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        this.apply(JSON.parse(line) as CreditRow);
      }
    }
  }

  private apply(row: CreditRow): void {
    const delta = BigInt(row.micro) * (row.kind === 'debit' ? -1n : 1n);
    this.balances.set(row.pubkey, (this.balances.get(row.pubkey) ?? 0n) + delta);
    this.rows.push(row);
  }

  private record(row: CreditRow): void {
    this.apply(row);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(row) + '\n');
    }
  }

  balance(pubkey: string): bigint {
    return this.balances.get(pubkey) ?? 0n;
  }

  topUp(pubkey: string, micro: bigint, ref: string): bigint {
    if (micro <= 0n) throw new BlossomError(400, 'top-up must be positive');
    this.record({ at: Math.floor(Date.now() / 1000), pubkey, kind: 'topup', micro: micro.toString(), ref });
    return this.balance(pubkey);
  }

  /** Takes `micro` from the pubkey or throws a 402 that says balance, price and where to fund. */
  debit(pubkey: string, micro: bigint, ref: string, fundAt: string): bigint {
    const have = this.balance(pubkey);
    if (have < micro) throw new BlossomError(402, `${npubOf(pubkey)} has ${microToUsdc(have)} USDC credit; this upload costs ${microToUsdc(micro)} USDC. Fund it at ${fundAt}`);
    if (micro > 0n) this.record({ at: Math.floor(Date.now() / 1000), pubkey, kind: 'debit', micro: micro.toString(), ref });
    return this.balance(pubkey);
  }

  refund(pubkey: string, micro: bigint, ref: string): bigint {
    if (micro > 0n) this.record({ at: Math.floor(Date.now() / 1000), pubkey, kind: 'refund', micro: micro.toString(), ref });
    return this.balance(pubkey);
  }

  /**
   * Debits that never resolved: more debits than refunds for a pubkey and blob,
   * and the blob is not archived. A gate that died mid-put (a restart, a crash)
   * took the credit and delivered nothing; the boot refunds these.
   */
  orphanedDebits(archived: (ref: string) => boolean): CreditRow[] {
    const byKey = new Map<string, { debits: CreditRow[]; refunds: number }>();
    for (const r of this.rows) {
      if (r.kind === 'topup') continue;
      const k = `${r.pubkey}:${r.ref}`;
      const e = byKey.get(k) ?? { debits: [], refunds: 0 };
      if (r.kind === 'debit') e.debits.push(r);
      else e.refunds += 1;
      byKey.set(k, e);
    }
    const out: CreditRow[] = [];
    for (const e of byKey.values()) {
      const open = e.debits.length - e.refunds;
      if (open <= 0 || archived(e.debits[0].ref)) continue;
      out.push(...e.debits.slice(-open));
    }
    return out;
  }

  history(pubkey: string): CreditRow[] {
    return this.rows.filter((r) => r.pubkey === pubkey);
  }
}

export const microToUsdc = (m: bigint): string => (Number(m) / 1e6).toFixed(6);

export function npubOf(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

// ---------------------------------------------------------------------------
// The descriptor and its extension

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/zip': 'zip',
};

export function extensionFor(mime: string | undefined): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? 'bin';
}

export function mimeFor(header: string | undefined): string {
  const base = (header ?? '').split(';')[0].trim().toLowerCase();
  return base && base !== 'application/octet-stream' ? base : 'application/octet-stream';
}

/** What the door needs from a Lading record to describe a blob. */
export interface BlobRecord {
  sha256: string;
  size: number;
  mime?: string;
  /** Unix seconds. */
  archivedAt: number;
  legs: { network: string; id: string; proof?: Record<string, string | number | undefined> }[];
  manifestUrl?: string;
  name?: string;
}

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  nip94: string[][];
  manifest: string | null;
  name: string | null;
  legs: Record<string, string>;
}

export function describe(baseUrl: string, r: BlobRecord): BlobDescriptor {
  const type = mimeFor(r.mime);
  const url = `${baseUrl.replace(/\/+$/, '')}/${r.sha256}.${extensionFor(type)}`;
  return {
    url,
    sha256: r.sha256,
    size: r.size,
    type,
    uploaded: r.archivedAt,
    nip94: [
      ['url', url],
      ['x', r.sha256],
      ['size', String(r.size)],
      ['m', type],
    ],
    manifest: r.manifestUrl ?? null,
    name: r.name ?? null,
    legs: Object.fromEntries(r.legs.map((l) => [l.network, l.id])),
  };
}

// ---------------------------------------------------------------------------
// The router

export interface BlossomDeps {
  /** The public origin clients embed, e.g. https://lading.167-233-221-236.sslip.io */
  baseUrl: string;
  maxBytes: number;
  credit: CreditLedger;
  /** Micro-USDC the door charges for a fresh put of `size` bytes. */
  price: (size: number) => Promise<bigint>;
  /** The record for a hash this gate already archived, if any. */
  archived: (sha: string) => BlobRecord | undefined;
  /** Runs the put and returns the record. */
  put: (bytes: Uint8Array, o: { name: string; mime?: string; pubkey: string }) => Promise<BlobRecord>;
  /** Every URL one leg's bytes may be read from, in the order to try. */
  readUrls: (leg: BlobRecord['legs'][number]) => string[];
  /** Reads the first URL that answers; undefined when none does. */
  readFirst: (urls: string[]) => Promise<{ bytes?: Uint8Array; status: number; url: string }>;
  sha256: (bytes: Uint8Array) => string;
  log: (...a: unknown[]) => void;
  fetchImpl?: typeof fetch;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, *',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE',
  'Access-Control-Expose-Headers': 'X-Reason, X-SHA-256, X-Content-Length, X-Content-Type',
};

/** `X-Reason` is the only thing a Blossom client shows the user; keep it to one line. */
function refuse(res: Response, e: unknown): void {
  const status = e instanceof BlossomError ? e.status : 500;
  // A header value is ASCII only: Node refuses the rest, and a refusal that throws is a 500 with no reason.
  const message = ((e as Error)?.message ?? String(e)).replace(/…/g, '...').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').slice(0, 200);
  res.status(status).set('X-Reason', message).json({ error: message });
}

const fundUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/v1/credit`;

/** The order to read a blob back: the network with the cheapest, closest gateway first. */
const READ_ORDER = ['ipfs', 'arweave', 'walrus', 'filecoin'];

export function blossomRouter(d: BlossomDeps): Router {
  const r = Router();
  const fund = fundUrl(d.baseUrl);

  r.use((_req, res, next) => {
    res.set(CORS_HEADERS);
    next();
  });
  r.options(/.*/, (_req, res) => res.status(204).end());

  const auth = (req: Request, verb: BlossomVerb): BlossomAuth => {
    const a = parseAuthHeader(req.get('authorization'));
    requireVerb(a, verb);
    return a;
  };

  /** Pre-flight: known bytes or enough credit, else 402 with the reason. */
  r.head('/upload', async (req, res) => {
    try {
      const sha = (req.get('x-sha-256') ?? '').toLowerCase();
      if (!SHA256_RE.test(sha)) throw new BlossomError(400, 'X-SHA-256 header required (hex sha256 of the blob)');
      const len = req.get('x-content-length');
      if (!len || !/^\d+$/.test(len)) throw new BlossomError(411, 'X-Content-Length header required: the door is priced on it');
      if (Number(len) > d.maxBytes) throw new BlossomError(413, `blob over the ${d.maxBytes} byte ceiling`);
      if (Number(len) === 0) throw new BlossomError(400, 'empty blob');
      const a = auth(req, 'upload');
      if (d.archived(sha)) return res.status(200).end();
      const price = await d.price(Number(len));
      const have = d.credit.balance(a.pubkey);
      if (have < price) throw new BlossomError(402, `${npubOf(a.pubkey)} has ${microToUsdc(have)} USDC credit; this upload costs ${microToUsdc(price)} USDC. Fund it at ${fund}`);
      return res.status(200).end();
    } catch (e) {
      return refuse(res, e);
    }
  });

  /** One blob in, priced like a put, debited from the pubkey's credit, archived, described. */
  const intake = async (req: Request, res: Response, bytes: Uint8Array, mime: string | undefined, a: BlossomAuth, declared?: string) => {
    if (bytes.length === 0) throw new BlossomError(400, 'empty blob');
    if (bytes.length > d.maxBytes) throw new BlossomError(413, `blob over the ${d.maxBytes} byte ceiling`);
    const sha = d.sha256(bytes);
    if (declared && declared !== sha) throw new BlossomError(409, `X-SHA-256 ${declared.slice(0, 12)}… does not match the bytes (${sha.slice(0, 12)}…)`);
    requireHash(a, sha);
    const prior = d.archived(sha);
    if (prior) {
      d.log(`blossom ${sha.slice(0, 12)} ${bytes.length} B from ${npubOf(a.pubkey).slice(0, 16)}… already archived, nothing charged`);
      return res.status(200).json(describe(d.baseUrl, prior));
    }
    const price = await d.price(bytes.length);
    d.credit.debit(a.pubkey, price, sha, fund);
    d.log(`blossom ${sha.slice(0, 12)} ${bytes.length} B ${mime ?? '-'} from ${npubOf(a.pubkey).slice(0, 16)}… debited ${microToUsdc(price)} USDC, credit left ${microToUsdc(d.credit.balance(a.pubkey))}`);
    let rec: BlobRecord;
    try {
      rec = await d.put(bytes, { name: `${sha.slice(0, 12)}.${extensionFor(mime)}`, mime, pubkey: a.pubkey });
    } catch (e) {
      d.credit.refund(a.pubkey, price, sha);
      d.log(`blossom ${sha.slice(0, 12)} put failed, refunded ${microToUsdc(price)} USDC: ${(e as Error).message}`);
      throw new BlossomError(502, `archive failed, credit refunded: ${(e as Error).message}`);
    }
    d.log(`blossom ${sha.slice(0, 12)} done: ${rec.legs.map((l) => l.network).join('+')} name=${rec.name ?? '-'}`);
    return res.status(201).json(describe(d.baseUrl, rec));
  };

  r.put('/upload', raw({ type: () => true, limit: d.maxBytes }), async (req, res) => {
    try {
      const a = auth(req, 'upload');
      const declared = req.get('x-sha-256')?.toLowerCase();
      if (declared !== undefined && !SHA256_RE.test(declared)) throw new BlossomError(400, 'X-SHA-256 must be a hex sha256');
      const mime = mimeFor(req.get('content-type'));
      await intake(req, res, new Uint8Array(req.body as Buffer), mime === 'application/octet-stream' ? undefined : mime, a, declared);
    } catch (e) {
      refuse(res, e);
    }
  });

  r.put('/mirror', json({ limit: '4kb' }), async (req, res) => {
    try {
      const a = auth(req, 'upload');
      const url = (req.body as { url?: unknown })?.url;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new BlossomError(400, 'body must be { "url": "https://…" }');
      const want = /([0-9a-f]{64})/i.exec(url)?.[1]?.toLowerCase();
      if (!want) throw new BlossomError(400, 'the url must carry the blob sha256');
      requireHash(a, want);
      const fetchImpl = d.fetchImpl ?? fetch;
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) throw new BlossomError(502, `source answered ${resp.status}`);
      const len = Number(resp.headers.get('content-length') ?? 0);
      if (len > d.maxBytes) throw new BlossomError(413, `source blob over the ${d.maxBytes} byte ceiling`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const mime = mimeFor(resp.headers.get('content-type') ?? undefined);
      await intake(req, res, bytes, mime === 'application/octet-stream' ? undefined : mime, a, want);
    } catch (e) {
      refuse(res, e);
    }
  });

  r.delete(/^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/i, (_req, res) => refuse(res, new BlossomError(403, 'a Lading archive is permanent; nothing to delete')));

  const serve = async (req: Request, res: Response, withBody: boolean) => {
    const sha = (req.params[0] as string).toLowerCase();
    const rec = d.archived(sha);
    if (!rec) return refuse(res, new BlossomError(404, 'blob not archived by this gate'));
    const type = mimeFor(rec.mime);
    // setHeader, not res.set: Express's set appends a charset to a text type, and the descriptor promised the bare type.
    res.setHeader('Content-Type', type);
    res.set({ 'Content-Length': String(rec.size), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-SHA-256': sha });
    if (!withBody) return res.status(200).end();
    const legs = [...rec.legs].sort((x, y) => READ_ORDER.indexOf(x.network) - READ_ORDER.indexOf(y.network));
    const urls = legs.flatMap((l) => d.readUrls(l));
    const got = await d.readFirst(urls);
    if (!got.bytes) return refuse(res, new BlossomError(502, `no gateway served the blob (last ${got.status} from ${got.url})`));
    if (d.sha256(got.bytes) !== sha) return refuse(res, new BlossomError(502, `gateway ${got.url} served bytes that do not hash to the blob`));
    res.set('X-Source', got.url);
    // end, not send: send would append a charset to the type the manifest recorded.
    return res.status(200).end(Buffer.from(got.bytes));
  };
  r.get(/^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/i, (req, res) => serve(req, res, true).catch((e) => refuse(res, e)));
  r.head(/^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/i, (req, res) => serve(req, res, false).catch((e) => refuse(res, e)));

  return r;
}

/** Express plumbing for a JSON 4xx from the credit doors. */
export const blossomErrorHandler = (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof BlossomError) return refuse(res, err);
  next(err);
};
