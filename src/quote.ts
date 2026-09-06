/**
 * Quote doors: the cheap question before the expensive leg.
 *
 * The connector charges the route price for every packet it delivers, so a
 * leg that the broker cannot fulfil (float empty, object too large, name not
 * ours) still costs the payer the full leg price. A quote door sells the
 * answer to "would this leg go through right now" for a small flat price, the
 * gas-station pattern, so the payer risks 1,000 units instead of 40,000.
 *
 * The decisions here are pure so they are testable; the doors in server.ts
 * feed them live balances and downstream prices.
 */

export interface WalrusQuote {
  op: 'walrus';
  deliverable: boolean;
  reason?: string;
  size: number;
  maxBytes: number;
  downstream: { provider: 'lighthouse-x402'; amountUsdc: string; retention: 'P365D' };
  float: { chain: 'base'; asset: 'USDC'; balance: string; reserve: string };
  executeDoor: '/walrus';
  at: number;
}

export interface NameQuote {
  op: 'name';
  deliverable: boolean;
  reason?: string;
  undername: string;
  name: string;
  antId: string;
  float: { chain: 'solana'; asset: 'SOL'; lamports: string; needLamports: string };
  executeDoor: '/name';
  at: number;
}

/** USDC amounts as decimal strings; compared in micro-units to avoid float drift. */
const micro = (usdc: string): bigint => {
  const [i, f = ''] = usdc.split('.');
  return BigInt(i || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};

/**
 * A Walrus leg goes through when the object fits the packet cap and the Base
 * key holds the downstream price with a reserve on top. The reserve keeps one
 * quote from promising the last cent to two callers at once.
 */
export function decideWalrus(input: {
  size: number;
  maxBytes: number;
  priceUsdc: string;
  balanceUsdc: string;
  reserveMultiple?: number;
}): { deliverable: boolean; reason?: string; reserveUsdc: string } {
  const mult = BigInt(input.reserveMultiple ?? 2);
  const reserve = micro(input.priceUsdc) * mult;
  const reserveUsdc = (Number(reserve) / 1e6).toFixed(6);
  if (input.size <= 0) return { deliverable: false, reason: 'object is empty', reserveUsdc };
  if (input.size > input.maxBytes) return { deliverable: false, reason: `object is ${input.size} bytes, over the ${input.maxBytes}-byte cap`, reserveUsdc };
  if (micro(input.balanceUsdc) < reserve) {
    return {
      deliverable: false,
      reason: `walrus float ${input.balanceUsdc} USDC on Base is under the ${reserveUsdc} USDC reserve for a ${input.priceUsdc} USDC upload`,
      reserveUsdc,
    };
  }
  return { deliverable: true, reserveUsdc };
}

/**
 * A name leg goes through when the undername is well formed, the signer still
 * holds authority on the ANT, and the key can pay one record write: rent for a
 * new record plus a fee, with a margin so two back-to-back jobs do not race
 * the same lamports.
 */
export function decideName(input: {
  undernameOk: boolean;
  txidOk: boolean;
  authorized: boolean;
  lamports: bigint;
  needLamports: bigint;
}): { deliverable: boolean; reason?: string } {
  if (!input.undernameOk) return { deliverable: false, reason: 'bad undername' };
  if (!input.txidOk) return { deliverable: false, reason: 'param txid must be an Arweave txId' };
  if (!input.authorized) return { deliverable: false, reason: 'signer is no longer owner or controller of the ANT' };
  if (input.lamports < input.needLamports) {
    return {
      deliverable: false,
      reason: `name float ${input.lamports} lamports is under the ${input.needLamports} needed for one record write`,
    };
  }
  return { deliverable: true };
}

/** A tiny TTL cache so quotes do not hit an RPC on every call. */
export function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let at = 0;
  let inflight: Promise<T> | undefined;
  return async () => {
    if (value !== undefined && Date.now() - at < ttlMs) return value;
    if (!inflight) {
      inflight = load()
        .then((v) => {
          value = v;
          at = Date.now();
          return v;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };
}
