/**
 * The Filecoin leg, executed on Filecoin Onchain Cloud through the Synapse SDK.
 *
 * Why this door and not Lighthouse: Lighthouse's hosted x402 endpoint is the
 * Walrus one (x402.lighthouse.storage and x402-walrus.lighthouse.storage answer
 * the same PAYMENT-REQUIRED), and its IPFS+Filecoin path is a prepaid API key
 * whose deal appears hours to a day later. Filecoin Onchain Cloud is the
 * network's own pay-on-proof service: the broker holds a USDFC balance in
 * Filecoin Pay, a storage provider stores the piece, commits it on chain into
 * a data set, and is paid per epoch only while its Proof of Data Possession
 * keeps landing. The receipt this door FULFILLs with is the PieceCID plus the
 * on-chain data set and piece ids, and the provider's own retrieval URL, read
 * back and compared to the object's sha256 before we answer.
 *
 * Money: the broker's Filecoin key holds USDFC (deposited once into Filecoin
 * Pay, see `npm run fund:filecoin`) and a little FIL for that deposit
 * transaction. Per object the provider takes a one-time add-piece fee
 * (about $0.011 per copy); the data set's recurring cost is $0.12 per month
 * plus $2.50 per TiB per copy, shared by every object the broker stores.
 * Retention is therefore per epoch: bytes stay while the broker's runway
 * lasts, and the receipt records that runway.
 */
import { createHash } from 'node:crypto';
import { Synapse, TOKENS, calibration, mainnet, formatUnits, type FilecoinChain, type UploadResult } from '@filoz/synapse-sdk';
import { epochsToDays } from '@filoz/synapse-core/utils';
import { MIN_SIZE } from '@filoz/synapse-core/piece';
import { ServiceAlreadyTerminatedError } from '@filoz/synapse-core/errors';
import { privateKeyToAccount } from 'viem/accounts';
import type { FilecoinReceipt } from './kinds.js';

/** Synapse rejects payloads under this many bytes; the docs say 127, the SDK constant is the source of truth. */
export const FILECOIN_MIN_BYTES = Math.max(Number(MIN_SIZE), 127);

/** Filecoin Pay reports an account with no spend rate as a runway of 2^256-1 epochs; render that as unbounded, never as a number. */
export const runwayText = (days: bigint) => (days > 1_000_000n ? 'unbounded' : days.toString());

export interface FilecoinQuoteInfo {
  /** The account can pay for an object of the quoted size without a new deposit. */
  ready: boolean;
  depositNeededUsdfc: string;
  ratePerMonthUsdfc: string;
  addPieceFeeUsdfc: string;
  availableUsdfc: string;
  runwayEpochs: bigint;
  runwayDays: bigint;
  filBalance: string;
}

export interface FilecoinUploader {
  chain: FilecoinChain;
  address: `0x${string}`;
  copies: number;
  quote(size: number): Promise<FilecoinQuoteInfo>;
  upload(bytes: Uint8Array, fileName: string): Promise<FilecoinReceipt>;
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The SDK's refusal to price or upload into a data set whose provider has ended the service (pdpEndEpoch set). */
export function isTerminatedDataSet(e: unknown): boolean {
  for (let cur = e, depth = 0; cur != null && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if (ServiceAlreadyTerminatedError.is(cur) || (cur as { name?: unknown }).name === 'ServiceAlreadyTerminatedError') return true;
  }
  return false;
}

/**
 * The Synapse client caches its storage contexts for the life of the process,
 * so when a provider terminates one of our data sets the cache keeps pointing
 * at it and every quote and upload throws (2026-11-13: provider 7 ended data
 * set 1575 under a 3-week-old broker). A fresh client skips terminated sets,
 * so on that one error drop the client and run once more. The SDK raises it
 * while pricing, before any bytes are stored, so the retry buys nothing twice.
 */
export async function retryOnTerminatedDataSet<T>(run: () => Promise<T>, reset: () => void): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isTerminatedDataSet(e)) throw e;
    console.log(`filecoin: cached data set is terminated, rebuilding the Synapse client: ${(e as Error).message}`);
    reset();
    return await run();
  }
}

export function filecoinChain(name: string | undefined): FilecoinChain {
  if (!name || name === 'mainnet') return mainnet;
  if (name === 'calibration') return calibration;
  throw new Error(`LADING_FILECOIN_CHAIN must be mainnet or calibration, not ${name}`);
}

/**
 * Read the piece back from the provider that stored it and compare sha256.
 * The provider serves `/piece/<PieceCID>` as soon as the store step returns,
 * so this is a short retry, not a wait for chain confirmation.
 */
export async function readBackPiece(url: string, expectedSha256: string, attempts = 4): Promise<{ check: string; ok: boolean }> {
  let status = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      status = r.status;
      if (r.ok) {
        const got = sha256Hex(new Uint8Array(await r.arrayBuffer()));
        return got === expectedSha256 ? { check: 'provider-sha256-match', ok: true } : { check: `provider-sha256-mismatch(${got.slice(0, 12)})`, ok: false };
      }
      if (r.status !== 404 && r.status !== 503) return { check: `provider-${status}`, ok: false };
    } catch (e) {
      return { check: `provider-error(${(e as Error).message.slice(0, 40)})`, ok: false };
    }
    await sleep(2000 * (i + 1));
  }
  return { check: `provider-${status}`, ok: false };
}

export function synapseUploader(opts: {
  privateKey: `0x${string}`;
  chain: FilecoinChain;
  copies?: number;
  source?: string;
  maxBytes: number;
}): FilecoinUploader {
  const account = privateKeyToAccount(opts.privateKey);
  const copies = opts.copies ?? 2;
  const fresh = () => Synapse.create({ account, chain: opts.chain, source: opts.source ?? 'lading' });
  let synapse = fresh();
  const reset = () => {
    synapse = fresh();
  };

  return {
    chain: opts.chain,
    address: account.address,
    copies,

    async quote(size) {
      // Priced at the packet cap, not the object: one conservative answer that
      // holds for every object this door accepts, so it can be cached.
      const pieceSize = BigInt(Math.max(size, FILECOIN_MIN_BYTES, opts.maxBytes));
      const [prep, summary, fil] = await retryOnTerminatedDataSet(
        () =>
          Promise.all([
            synapse.storage.prepare({ pieceSizes: Array.from({ length: copies }, () => pieceSize) }),
            synapse.payments.accountSummary(),
            synapse.payments.walletBalance({ token: TOKENS.FIL }),
          ]),
        reset,
      );
      const c = prep.costs;
      return {
        ready: c.ready,
        depositNeededUsdfc: formatUnits(c.depositNeeded),
        ratePerMonthUsdfc: formatUnits(c.rates.perMonth),
        addPieceFeeUsdfc: formatUnits(c.fees.total),
        availableUsdfc: formatUnits(summary.availableFunds),
        runwayEpochs: summary.runwayInEpochs,
        runwayDays: epochsToDays(summary.runwayInEpochs),
        filBalance: formatUnits(fil),
      };
    },

    async upload(bytes, fileName) {
      const sha = sha256Hex(bytes);
      if (bytes.length < FILECOIN_MIN_BYTES) throw new Error(`object is ${bytes.length} bytes; Filecoin pieces start at ${FILECOIN_MIN_BYTES}`);
      let txHash: string | undefined;
      const result: UploadResult = await retryOnTerminatedDataSet(
        () =>
          synapse.storage.upload(bytes, {
            copies,
            pieceMetadata: { filename: fileName.slice(0, 120), sha256: sha },
            callbacks: {
              onPiecesAdded: (tx) => {
                txHash ??= tx;
              },
            },
          }),
        reset,
      );
      // A copy that failed on a terminated set does not throw (the other copy
      // landed); drop the cache so the next object gets a live second set.
      if (result.failedAttempts.some((f) => /already terminated/i.test(f.error))) reset();
      if (result.copies.length === 0) throw new Error(`no copy committed: ${result.failedAttempts.map((f) => `${f.providerId}:${f.error}`).join('; ')}`);
      const primary = result.copies.find((c) => c.role === 'primary') ?? result.copies[0]!;
      const check = await readBackPiece(primary.retrievalUrl, sha);
      if (!check.ok) throw new Error(`piece ${result.pieceCid} committed but read-back failed: ${check.check}`);

      let runwayDays: bigint | undefined;
      try {
        runwayDays = epochsToDays((await synapse.payments.accountSummary()).runwayInEpochs);
      } catch {
        /* the receipt is still good without the runway line */
      }

      const receipt: FilecoinReceipt = {
        network: 'filecoin',
        id: result.pieceCid.toString(),
        sha256: sha,
        size: bytes.length,
        retention: 'per-epoch',
        provider: 'filecoin-onchain-cloud',
        proof: {
          pieceCid: result.pieceCid.toString(),
          readUrl: primary.retrievalUrl,
          chain: `filecoin:${opts.chain.id}`,
          dataSetId: primary.dataSetId.toString(),
          pieceId: primary.pieceId.toString(),
          providerId: primary.providerId.toString(),
          payer: account.address,
          copies: result.copies.length,
          copiesRequested: result.requestedCopies,
          complete: result.complete ? 'yes' : 'no',
          ...(result.copies.length > 1 ? { secondaryUrls: result.copies.filter((c) => c !== primary).map((c) => c.retrievalUrl).join(' ') } : {}),
          ...(txHash ? { txHash } : {}),
          ...(runwayDays !== undefined ? { runwayDays: runwayText(runwayDays) } : {}),
          readback: check.check,
          verified: 'yes',
        },
        at: Math.floor(Date.now() / 1000),
      };
      return receipt;
    },
  };
}
