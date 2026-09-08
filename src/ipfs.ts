/**
 * The IPFS leg, executed through Pinata's hosted x402 door.
 *
 * Why Pinata: as of 2026-09 it is the one production pinning service that
 * sells a pin per request for USDC on Base with no account (Storacha turned
 * writes off in May 2026 and folded into fil.one; Infura and Fleek shut their
 * IPFS doors; Filebase and 4EVERLAND want a subscription). The door
 * (`402.pinata.cloud`) prices a pin on `fileSize`: 0.10 USDC per GiB for
 * twelve months, floored at 0.001 USDC, so a 1 MiB object costs ~0.0012 USDC
 * and everything up to the packet cap stays under 0.005. The TOON route in
 * front of this door is therefore priced flat.
 *
 * Flow: an unpaid POST answers 402 with the price; the paid POST answers a
 * signed upload URL; a multipart POST there returns the CID. Bytes are read
 * back from Pinata's gateway (proves the pin holds them) and from a gateway
 * Pinata does not run (proves the content is reachable on the network), and
 * the receipt records which answered. The CID is checked offline too when it
 * is a raw sha256 CID.
 */
import { createHash } from 'node:crypto';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { IpfsReceipt } from './kinds.js';
import { rawCidSha256 } from './walrus.js';
import { DEFAULT_IPFS_GATEWAY, DEFAULT_IPFS_GATEWAYS, ipfsReadUrls, readGateways } from './read.js';

export const PINATA_402 = process.env.PINATA_402_URL ?? 'https://402.pinata.cloud';
/** Gateways an IPFS CID is read back from, in order: the pinner's own first, then ones it does not run. */
export const IPFS_GATEWAYS = readGateways(process.env.LADING_IPFS_GATEWAY ?? DEFAULT_IPFS_GATEWAY, process.env.LADING_IPFS_GATEWAYS, DEFAULT_IPFS_GATEWAYS);
/** Lading's own kubo (RPC API on the compose network). Every pinned object is added here too; unset = skip. */
export const KUBO_API = process.env.LADING_KUBO_API?.trim() || undefined;
export const PINATA_GATEWAY = 'gateway.pinata.cloud';
/** What the door sells: twelve months of pinning per payment. */
export const PINATA_RETENTION = 'P365D';
const PINATA_RETENTION_MS = 365 * 86_400_000;

export interface IpfsUploader {
  /** The Base address that pays Pinata. */
  readonly address: `0x${string}`;
  quote(size: number): Promise<{ amountUsdc: string; raw: unknown }>;
  upload(bytes: Uint8Array, fileName: string): Promise<IpfsReceipt>;
}

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * The price inside an x402 v2 402 answer: the `payment-required` header is
 * base64 JSON with `accepts[].amount` in the asset's base units (micro-USDC
 * here). Pure, so the shape is tested without the network.
 */
export function priceFromPaymentRequired(header: string | null, network = 'eip155:8453'): { amountMicro: bigint; payTo?: string; raw: unknown } {
  if (!header) throw new Error('402 without a payment-required header');
  let raw: { accepts?: Array<{ scheme?: string; network?: string; amount?: string; payTo?: string }> };
  try {
    raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new Error('payment-required header is not base64 JSON');
  }
  const offer = raw.accepts?.find((a) => a.scheme === 'exact' && a.network === network) ?? raw.accepts?.[0];
  if (!offer?.amount || !/^\d+$/.test(offer.amount)) throw new Error(`payment-required carries no exact amount for ${network}: ${JSON.stringify(raw).slice(0, 200)}`);
  return { amountMicro: BigInt(offer.amount), payTo: offer.payTo, raw };
}

export const microToUsdc = (u: bigint) => `${u / 1_000_000n}.${(u % 1_000_000n).toString().padStart(6, '0')}`;

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

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

/**
 * Read the CID back through the gateway list: Lading's own kubo first (it just
 * added the bytes, so it answers at once), then Pinata's (the pin itself, a
 * few tries because its public gateway rate-limits), then gateways neither of
 * us runs. FULFILL requires Pinata to have answered the pin AND some gateway
 * to serve bytes with the right sha256; `publicUrl` records the first gateway
 * that is not ours.
 */
/** Tries on the pinner's own gateway before giving up: with 3 s × n backoff, 10 tries wait about 165 s plus fetch time. A 1 MiB dag-pb CID took over two minutes to appear on 2026-09-08. */
export const PINNER_READBACK_ATTEMPTS = Number(process.env.LADING_IPFS_READBACK_ATTEMPTS ?? 10);

export async function readBack(cid: string, expectedSha256: string, gateways = IPFS_GATEWAYS, attempts = PINNER_READBACK_ATTEMPTS): Promise<{ checks: string[]; strong: boolean; readUrl?: string; publicUrl?: string }> {
  const checks: string[] = [];
  const cidSha = rawCidSha256(cid);
  checks.push(cidSha === expectedSha256 ? 'cid-digest=sha256' : cidSha ? `cid-digest-mismatch(${cidSha.slice(0, 12)})` : 'cid-not-raw');
  let readUrl: string | undefined;
  let publicUrl: string | undefined;
  for (const [i, url] of ipfsReadUrls(cid, gateways).entries()) {
    const host = gateways[i]!;
    const ours = i === 0 && KUBO_API !== undefined;
    const tries = ours ? 2 : host === PINATA_GATEWAY ? attempts : 1;
    for (let t = 0; t < tries; t++) {
      try {
        const r = await fetch(url, { cache: 'no-store', signal: withTimeout(ours || host === PINATA_GATEWAY ? 60_000 : 30_000), headers: { accept: 'application/octet-stream' } });
        if (r.ok) {
          const ok = sha256Hex(new Uint8Array(await r.arrayBuffer())) === expectedSha256;
          checks.push(`${host}:${ok ? 'sha256-match' : 'sha256-mismatch'}`);
          if (ok && !readUrl) readUrl = url;
          if (ok && !ours && !publicUrl) publicUrl = url;
          break;
        }
        checks.push(`${host}:${r.status}`);
        // Not there yet (404), rate limited (429, Pinata's public gateway does this under load), or a gateway hiccup (5xx): wait and ask again. Anything else is an answer.
        if (r.status !== 404 && r.status !== 429 && r.status < 500) break;
      } catch (e) {
        checks.push(`${host}:${(e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message.slice(0, 30)}`);
      }
      if (t < tries - 1) await new Promise((d) => setTimeout(d, 3000 * (t + 1) + (host === PINATA_GATEWAY ? 5000 : 0)));
    }
    // Enough once a gateway that is not ours has served the bytes.
    if (publicUrl) break;
  }
  const strong = checks.includes('cid-digest=sha256') || readUrl !== undefined;
  return { checks, strong, readUrl, publicUrl };
}

/**
 * Add the bytes to Lading's own kubo, pinned, with the same UnixFS layout
 * Pinata uses (CIDv1, raw leaves, 256 KiB balanced chunks) so both sides
 * name the object by the same CID. Answers the CID kubo computed.
 */
export async function kuboAdd(bytes: Uint8Array, fileName: string, api = KUBO_API): Promise<string> {
  if (!api) throw new Error('LADING_KUBO_API unset');
  const form = new FormData();
  form.append('file', new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/octet-stream' }), fileName);
  const r = await fetch(`${api}/api/v0/add?pin=true&cid-version=1&raw-leaves=true&chunker=size-262144&quieter=true`, { method: 'POST', body: form, signal: withTimeout(120_000) });
  if (!r.ok) throw new Error(`kubo add failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { Hash?: string };
  if (!j.Hash) throw new Error(`kubo add returned no Hash: ${JSON.stringify(j).slice(0, 200)}`);
  return j.Hash;
}

export function pinataUploader(evmPrivateKey: `0x${string}`, o: { network?: string; base?: string } = {}): IpfsUploader {
  const signer = privateKeyToAccount(evmPrivateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const payFetch = wrapFetchWithPayment(fetch, client);
  const network = o.network ?? 'eip155:8453';
  const base = o.base ?? PINATA_402;
  const door = (size: number) => `${base}/v1/pin/public?fileSize=${size}`;

  return {
    address: signer.address,

    async quote(size) {
      const r = await fetch(door(size), { method: 'POST', signal: withTimeout(20_000) });
      if (r.status !== 402) throw new Error(`pinata price probe answered ${r.status}, not 402: ${(await r.text()).slice(0, 200)}`);
      const p = priceFromPaymentRequired(r.headers.get('payment-required'), network);
      return { amountUsdc: microToUsdc(p.amountMicro), raw: p.raw };
    },

    async upload(bytes, fileName) {
      const sha = sha256Hex(bytes);
      // Pay for the pin: the door answers a signed upload URL good for a short while.
      const res = await payFetch(door(bytes.length), { method: 'POST' });
      if (!res.ok) throw new Error(`pinata 402 door failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      const out = (await res.json()) as { url?: string };
      if (!out.url || !/^https:\/\//.test(out.url)) throw new Error(`pinata door returned no upload url: ${JSON.stringify(out).slice(0, 200)}`);
      const settlement = settlementOf(res);

      // The upload itself, the way the pinata SDK does it for a signed URL.
      const form = new FormData();
      form.append('file', new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/octet-stream' }), fileName);
      form.append('network', 'public');
      form.append('name', fileName);
      const up = await fetch(out.url, { method: 'POST', body: form, signal: withTimeout(180_000) });
      if (!up.ok) throw new Error(`pinata upload failed: ${up.status} ${(await up.text()).slice(0, 300)}`);
      const j = (await up.json()) as { data?: { id?: string; cid?: string; size?: number; created_at?: string } };
      const cid = j.data?.cid;
      if (!cid) throw new Error(`pinata upload returned no cid: ${JSON.stringify(j).slice(0, 200)}`);

      // Our own copy, under the same CID, before the read-back so our gateway can answer it.
      let kubo: string | undefined;
      if (KUBO_API) {
        try {
          const ours = await kuboAdd(bytes, fileName);
          kubo = ours === cid ? 'pinned' : `cid-mismatch(${ours})`;
        } catch (e) {
          kubo = `failed(${(e as Error).message.slice(0, 80)})`;
        }
      }
      const check = await readBack(cid, sha);
      if (!check.strong) throw new Error(`pinata pinned ${cid} but no read-back matched: ${check.checks.join(';')}`);
      const at = Math.floor(Date.now() / 1000);
      const receipt: IpfsReceipt = {
        network: 'ipfs',
        id: cid,
        sha256: sha,
        size: bytes.length,
        retention: PINATA_RETENTION,
        provider: 'pinata-x402',
        proof: {
          cid,
          readUrl: check.readUrl ?? ipfsReadUrls(cid, IPFS_GATEWAYS)[0]!,
          ...(check.publicUrl ? { publicUrl: check.publicUrl } : {}),
          ...(j.data?.id ? { pinataId: j.data.id } : {}),
          ...(kubo ? { kubo } : {}),
          expiresAt: at * 1000 + PINATA_RETENTION_MS,
          ...(settlement.transaction ? { baseTx: settlement.transaction } : {}),
          ...(settlement.payer ? { payer: settlement.payer } : {}),
          readback: check.checks.join(';'),
          verified: check.strong ? 'yes' : 'no',
        },
        at,
      };
      return receipt;
    },
  };
}
