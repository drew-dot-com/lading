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
import type { WalrusReceipt } from './kinds.js';

export const LIGHTHOUSE_X402 = process.env.LIGHTHOUSE_X402_URL ?? 'https://x402-walrus.lighthouse.storage';
export const LIGHTHOUSE_API = process.env.LIGHTHOUSE_API_URL ?? 'https://api.lighthouse.storage';
export const WALRUS_AGGREGATOR =
  process.env.WALRUS_AGGREGATOR_URL ?? 'https://aggregator.walrus-mainnet.walrus.space';

export interface WalrusUploader {
  quote(size: number): Promise<{ amountUsdc: string; raw: unknown }>;
  upload(bytes: Uint8Array, fileName: string): Promise<WalrusReceipt>;
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

/** Read the bytes behind a blobId from the aggregator and compare to the expected sha256. */
export async function readBack(
  blobId: string,
  expectedSha256: string,
  attempts = 5,
): Promise<{ verified: boolean; status: number; sha256?: string }> {
  let status = 0;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}?cb=${Date.now()}`);
    status = r.status;
    if (r.ok) {
      const got = sha256Hex(new Uint8Array(await r.arrayBuffer()));
      return { verified: got === expectedSha256, status, sha256: got };
    }
    if (r.status !== 404) break;
    await sleep(3000 * (i + 1));
  }
  return { verified: false, status };
}

export function lighthouseUploader(evmPrivateKey: `0x${string}`): WalrusUploader {
  const signer = privateKeyToAccount(evmPrivateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const payFetch = wrapFetchWithPayment(fetch, client);

  return {
    async quote(size) {
      const r = await fetch(`${LIGHTHOUSE_X402}/api/upload/price?size=${size}`);
      if (!r.ok) throw new Error(`price quote failed: ${r.status} ${await r.text()}`);
      const raw = (await r.json()) as Record<string, unknown>;
      // Live shape (2026-09-06): { totalPrice: "$0.032500", billableMiB, encodedSizeBytes, storagePeriodDays, network, payTo }
      return { amountUsdc: String(raw.totalPrice ?? JSON.stringify(raw)), raw };
    },

    async upload(bytes, fileName) {
      const sha = sha256Hex(bytes);
      const res = await payFetch(`${LIGHTHOUSE_X402}/api/upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-file-name': fileName,
        },
        body: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]),
      });
      if (!res.ok) throw new Error(`lighthouse upload failed: ${res.status} ${await res.text()}`);
      const out = (await res.json()) as LighthouseUploadResponse;
      if (!out.success || !out.cid) throw new Error(`lighthouse upload returned no cid: ${JSON.stringify(out)}`);

      let settlement: { transaction?: string; payer?: string } = {};
      const settle = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
      if (settle) {
        try {
          settlement = JSON.parse(Buffer.from(settle, 'base64').toString('utf8'));
        } catch {
          /* header present but unreadable: not a receipt failure */
        }
      }

      const blobIds = await walrusBlobIds(out.cid);
      const blobId = blobIds[0]!;
      const check = await readBack(blobId, sha);

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
          readback: check.verified ? 'sha256-match' : `unverified (aggregator ${check.status}${check.sha256 ? `, got ${check.sha256.slice(0, 12)}` : ''})`,
        },
        at: Math.floor(Date.now() / 1000),
      };
      return receipt;
    },
  };
}
