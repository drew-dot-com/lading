/**
 * The Walrus leg, executed through Lighthouse's hosted x402 endpoint.
 *
 * Why Lighthouse and not a native Walrus publisher: there is no public mainnet
 * publisher, and the native path needs a Sui wallet holding SUI and WAL. The
 * Lighthouse door takes USDC on Base over x402 v2 and returns a CID, a
 * Lighthouse record id (needed for renewal) and, one call later, the Walrus
 * blobId. Bytes are then read back from the public Walrus aggregator and
 * compared to the object's sha256, so the receipt this door FULFILLs with is
 * checkable by anyone with the blobId.
 *
 * Pricing: $0.0005 per ENCODED MiB per year plus a $0.001 facilitator fee,
 * billed on the erasure-coded size (about 63 MiB of overhead per blob), so
 * every upload costs roughly $0.032 to $0.036 up to the 2 MiB packet cap.
 * The TOON route in front of this door is therefore priced flat.
 */
import { createHash } from 'node:crypto';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { WalrusReceipt, WalrusRenewReceipt } from './kinds.js';

export const LIGHTHOUSE_X402 = process.env.LIGHTHOUSE_X402_URL ?? 'https://x402-walrus.lighthouse.storage';
export const LIGHTHOUSE_API = process.env.LIGHTHOUSE_API_URL ?? 'https://api.lighthouse.storage';
export const WALRUS_AGGREGATOR =
  process.env.WALRUS_AGGREGATOR_URL ?? 'https://aggregator.walrus-mainnet.walrus.space';

export interface WalrusUploader {
  /** The Base address that pays Lighthouse, and so the only wallet Lighthouse lets renew what this door uploaded. */
  readonly address: `0x${string}`;
  quote(size: number): Promise<{ amountUsdc: string; raw: unknown }>;
  upload(bytes: Uint8Array, fileName: string): Promise<WalrusReceipt>;
  /** Lighthouse's own answer for a record: price of one more period and the current paid-through instant. `found: false` on a 404. */
  renewQuote(lighthouseId: string): Promise<RenewQuote>;
  /** Buy one more storage period for a record this key uploaded. Lighthouse stacks it on the current expiry. */
  renew(lighthouseId: string): Promise<WalrusRenewReceipt>;
}

export interface RenewQuote {
  found: boolean;
  amountUsdc: string;
  cid?: string;
  size?: number;
  currentExpiresAt?: number;
  storagePeriodDays?: number;
  raw: unknown;
}

interface LighthouseRenewResponse {
  success: boolean;
  id: string;
  cid: string;
  fileName: string;
  fileSizeBytes: number;
  previousExpiresAt: number;
  expiresAt: number;
  storagePeriodDays: number;
  publicKey: string;
}

interface LighthouseUploadResponse {
  success: boolean;
  id: string;
  cid: string;
  fileSizeBytes: number;
  expiresAt: number;
  storagePeriodDays: number;
  publicKey: string;
  ipfsUrl: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask Lighthouse which Walrus blob ids back a CID. Retries: the mapping lags the upload by a few seconds. */
export async function walrusBlobIds(cid: string, attempts = 6): Promise<string[]> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${LIGHTHOUSE_API}/api/lighthouse/walrus_blobs?cid=${encodeURIComponent(cid)}`);
    if (r.ok) {
      const j = (await r.json()) as { blobIds?: string[] };
      if (j.blobIds && j.blobIds.length > 0) return j.blobIds;
      last = 'empty blobIds';
    } else {
      last = `${r.status} ${await r.text()}`;
    }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`walrus_blobs lookup failed for ${cid}: ${last}`);
}

/**
 * Decode a CIDv1 in base32 (`b...`) and return its multihash digest when it is
 * a raw-codec sha256 CID (`bafkrei...`). Lighthouse returns exactly that shape
 * for a single-block file, so the CID itself commits to the file's sha256.
 */
export function rawCidSha256(cid: string): string | undefined {
  if (!cid.startsWith('b')) return undefined;
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = '';
  for (const ch of cid.slice(1)) {
    const v = A.indexOf(ch);
    if (v < 0) return undefined;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  // version 1, codec 0x55 raw, multihash fn 0x12 sha2-256, length 0x20
  if (bytes[0] !== 1 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20) return undefined;
  return Buffer.from(bytes.slice(4, 36)).toString('hex');
}

/**
 * Three independent checks on what Lighthouse put on Walrus, strongest first:
 *  1. the CID's own digest equals the file sha256 (offline, no trust in any server);
 *  2. the Lighthouse Walrus gateway serves bytes with that sha256;
 *  3. the public Walrus aggregator serves the blob, and it either IS the file
 *     or wraps it (Lighthouse's datastore frames blocks, so the blob can be a
 *     few hundred bytes longer than the file; containment is what we check).
 * The receipt records each outcome; FULFILL requires the blobId to resolve.
 */
export async function readBack(
  blobId: string,
  cid: string,
  ipfsUrl: string | undefined,
  file: Uint8Array,
  expectedSha256: string,
  attempts = 4,
): Promise<{ checks: string[]; strong: boolean }> {
  const checks: string[] = [];
  const cidSha = rawCidSha256(cid);
  checks.push(cidSha === expectedSha256 ? 'cid-digest=sha256' : `cid-digest-mismatch(${cidSha?.slice(0, 12) ?? 'not-raw-cid'})`);

  if (ipfsUrl) {
    try {
      const g = await fetch(ipfsUrl, { cache: 'no-store' });
      checks.push(g.ok ? (sha256Hex(new Uint8Array(await g.arrayBuffer())) === expectedSha256 ? 'gateway-sha256-match' : 'gateway-sha256-mismatch') : `gateway-${g.status}`);
    } catch (e) {
      checks.push(`gateway-error(${(e as Error).message.slice(0, 40)})`);
    }
  }

  let status = 0;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`, { cache: 'no-store' });
    status = r.status;
    if (r.ok) {
      const blob = Buffer.from(await r.arrayBuffer());
      const same = sha256Hex(new Uint8Array(blob)) === expectedSha256;
      const wraps = !same && blob.indexOf(Buffer.from(file)) >= 0;
      checks.push(same ? 'aggregator-sha256-match' : wraps ? `aggregator-car-wraps-file(+${blob.length - file.length}B)` : `aggregator-blob-differs(${blob.length}B)`);
      break;
    }
    if (r.status !== 404) {
      checks.push(`aggregator-${status}`);
      break;
    }
    if (i === attempts - 1) checks.push('aggregator-404');
    await sleep(3000 * (i + 1));
  }
  const strong = checks.includes('cid-digest=sha256') || checks.includes('gateway-sha256-match') || checks.includes('aggregator-sha256-match');
  return { checks, strong };
}

/** The x402 settlement header, when the facilitator sent one back: Base tx and payer. Unreadable is not a receipt failure. */
function settlementOf(res: Response): { transaction?: string; payer?: string } {
  const settle = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
  if (!settle) return {};
  try {
    return JSON.parse(Buffer.from(settle, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

export function lighthouseUploader(evmPrivateKey: `0x${string}`): WalrusUploader {
  const signer = privateKeyToAccount(evmPrivateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const payFetch = wrapFetchWithPayment(fetch, client);

  return {
    address: signer.address,

    async renewQuote(lighthouseId) {
      const r = await fetch(`${LIGHTHOUSE_X402}/api/renew/price?id=${encodeURIComponent(lighthouseId)}`);
      if (r.status === 404) return { found: false, amountUsdc: '0', raw: await r.json().catch(() => null) };
      if (!r.ok) throw new Error(`renew price failed: ${r.status} ${await r.text()}`);
      const raw = (await r.json()) as Record<string, unknown>;
      // Live shape (2026-09-07): { id, cid, fileSizeBytes, billableMiB, totalPrice: "$0.034500", storagePeriodDays, currentExpiresAt, network, payTo }
      const total = String(raw.totalPrice ?? '').replace(/^\$/, '');
      if (!/^\d+(\.\d+)?$/.test(total)) throw new Error(`renew price has no totalPrice: ${JSON.stringify(raw)}`);
      return {
        found: true,
        amountUsdc: total,
        cid: typeof raw.cid === 'string' ? raw.cid : undefined,
        size: typeof raw.fileSizeBytes === 'number' ? raw.fileSizeBytes : undefined,
        currentExpiresAt: typeof raw.currentExpiresAt === 'number' ? raw.currentExpiresAt : undefined,
        storagePeriodDays: typeof raw.storagePeriodDays === 'number' ? raw.storagePeriodDays : undefined,
        raw,
      };
    },

    async renew(lighthouseId) {
      const res = await payFetch(`${LIGHTHOUSE_X402}/api/renew`, { method: 'POST', headers: { 'x-file-id': lighthouseId } });
      if (!res.ok) throw new Error(`lighthouse renew failed: ${res.status} ${await res.text()}`);
      const out = (await res.json()) as LighthouseRenewResponse;
      if (!out.success || !out.expiresAt || out.expiresAt <= (out.previousExpiresAt ?? 0)) throw new Error(`lighthouse renew returned no new expiry: ${JSON.stringify(out)}`);
      const settlement = settlementOf(res);
      const blobIds = await walrusBlobIds(out.cid);
      const blobId = blobIds[0]!;
      return {
        network: 'walrus',
        op: 'renew',
        lighthouseId: out.id,
        blobId,
        cid: out.cid,
        size: out.fileSizeBytes,
        previousExpiresAt: out.previousExpiresAt,
        expiresAt: out.expiresAt,
        extended: `P${out.storagePeriodDays ?? 365}D`,
        provider: 'lighthouse-x402',
        proof: {
          readUrl: `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`,
          ...(settlement.transaction ? { baseTx: settlement.transaction } : {}),
          ...(settlement.payer ? { payer: settlement.payer } : {}),
        },
        at: Math.floor(Date.now() / 1000),
      };
    },

    async quote(size) {
      const r = await fetch(`${LIGHTHOUSE_X402}/api/upload/price?size=${size}`);
      if (!r.ok) throw new Error(`price quote failed: ${r.status} ${await r.text()}`);
      const raw = (await r.json()) as Record<string, unknown>;
      // Live shape (2026-09-06): { totalPrice: "$0.032500", billableMiB, encodedSizeBytes, storagePeriodDays, network, payTo }
      const total = String(raw.totalPrice ?? '').replace(/^\$/, '');
      if (!/^\d+(\.\d+)?$/.test(total)) throw new Error(`price quote has no totalPrice: ${JSON.stringify(raw)}`);
      return { amountUsdc: total, raw };
    },

    async upload(bytes, fileName) {
      const sha = sha256Hex(bytes);
      const res = await payFetch(`${LIGHTHOUSE_X402}/api/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': fileName,
        },
        body: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]),
      });
      if (!res.ok) throw new Error(`lighthouse upload failed: ${res.status} ${await res.text()}`);
      const out = (await res.json()) as LighthouseUploadResponse;
      if (!out.success || !out.cid) throw new Error(`lighthouse upload returned no cid: ${JSON.stringify(out)}`);

      const settlement = settlementOf(res);

      const blobIds = await walrusBlobIds(out.cid);
      const blobId = blobIds[0]!;
      const check = await readBack(blobId, out.cid, out.ipfsUrl, bytes, sha);

      const receipt: WalrusReceipt = {
        network: 'walrus',
        id: blobId,
        sha256: sha,
        size: bytes.length,
        retention: `P${out.storagePeriodDays ?? 365}D`,
        provider: 'lighthouse-x402',
        proof: {
          blobId,
          readUrl: `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`,
          cid: out.cid,
          ipfsUrl: out.ipfsUrl,
          lighthouseId: out.id,
          expiresAt: out.expiresAt,
          ...(settlement.transaction ? { baseTx: settlement.transaction } : {}),
          ...(settlement.payer ? { payer: settlement.payer } : {}),
          readback: check.checks.join(';'),
          verified: check.strong ? 'yes' : 'no',
        },
        at: Math.floor(Date.now() / 1000),
      };
      return receipt;
    },
  };
}
