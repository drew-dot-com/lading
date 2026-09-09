/**
 * The Walrus leg, executed natively: this broker's own Sui key pays WAL for
 * storage and SUI for gas, writes through Mysten's upload relay, and gets the
 * certified blob object back from the chain. No Lighthouse in the path.
 *
 * Facts this rests on (checked 2026-09-08):
 *  - `@mysten/walrus` 1.2.23 on `@mysten/sui` 2.29 (gRPC; Sui mainnet
 *    JSON-RPC has been off since 2026-07-27). Pure JS plus a WASM encoder.
 *  - There is no public mainnet publisher and Mysten says there will be none;
 *    the relay `upload-relay.mainnet.walrus.space` takes a SUI tip (linear,
 *    40 MIST per encoded KiB, about 0.0026 SUI for a small blob) and does the
 *    ~2,200 storage-node requests a direct write would need. Register and
 *    certify are still this key's transactions.
 *  - An epoch is two weeks, at most 53 per store. 26 epochs is 364 days.
 *    Cost is on the ENCODED size (about 63 MiB of fixed overhead, then ~4.5x),
 *    so 200 B and 1 MiB both cost about 0.15 WAL for 26 epochs; `storageCost`
 *    is read live from the system object, never hardcoded.
 *  - A permanent (non-deletable) blob cannot be deleted before its end epoch;
 *    the owner can extend it (`extendBlob` by blob OBJECT id), so the object
 *    id goes in the receipt proof.
 *
 * Read-back: the public aggregator serves exactly the bytes that were written
 * (no framing), so the receipt's `readback` is a plain sha256 comparison.
 */
import { createHash } from 'node:crypto';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { walrus, blobIdFromInt } from '@mysten/walrus';
import type { WalrusExtendReceipt, WalrusReceipt } from './kinds.js';

export const SUI_RPC = process.env.SUI_GRPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
export const WALRUS_UPLOAD_RELAY = process.env.WALRUS_UPLOAD_RELAY ?? 'https://upload-relay.mainnet.walrus.space';
export const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR_URL ?? 'https://aggregator.walrus-mainnet.walrus.space';
/** Mainnet WAL coin type (metadata symbol WAL, 9 decimals). */
export const WAL_COIN_TYPE = '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL';
export const SUI_COIN_TYPE = '0x2::sui::SUI';
/** Epochs bought per write: 26 two-week epochs = 364 days, the same year Lighthouse sells. */
export const WALRUS_EPOCHS = Number(process.env.LADING_WALRUS_EPOCHS ?? 26);
export const EPOCH_DAYS = 14;
/** The most SUI the relay may take as its tip for one write, in MIST. */
const TIP_MAX_MIST = Number(process.env.LADING_WALRUS_TIP_MAX_MIST ?? 20_000_000);
/** SUI kept aside per write for register + certify gas on top of the tip (measured ~0.00015 SUI computation; the storage deposit is mostly rebated). */
export const SUI_PER_WRITE = process.env.LADING_WALRUS_SUI_PER_WRITE ?? '0.03';

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The instant a storage period ending at `endEpoch` runs out: the start of
 * that epoch. Epoch 0 was genesis; epoch 1 began at `first_epoch_start` and
 * every epoch since lasts `epoch_duration` (two weeks on mainnet).
 */
export const epochEndsAt = (endEpoch: number, firstEpochStartMs: number, epochDurationMs: number) => firstEpochStartMs + (endEpoch - 1) * epochDurationMs;

/** The address out of a Sui object's `owner` field, whatever shape the client hands back. */
export function ownerAddress(owner: unknown): string | undefined {
  if (!owner || typeof owner !== 'object') return typeof owner === 'string' ? owner : undefined;
  const o = owner as Record<string, unknown>;
  for (const k of ['AddressOwner', 'address', 'Address', 'ObjectOwner']) if (typeof o[k] === 'string') return o[k] as string;
  return undefined;
}

/** 9-decimal base units (FROST for WAL, MIST for SUI) as a decimal string. */
export const nineDec = (u: bigint) => `${u / 1_000_000_000n}.${(u % 1_000_000_000n).toString().padStart(9, '0')}`;

export interface NativeWalrusQuote {
  amountWal: string;
  amountFrost: bigint;
  epochs: number;
  currentEpoch: number;
  endEpoch: number;
  raw: unknown;
}

export interface NativeWalrusFloats {
  wal: string;
  sui: string;
  walFrost: bigint;
  suiMist: bigint;
}

/** Walrus epoch timing from the staking object: epoch `e` runs from `firstEpochStartMs + (e - 1) * epochDurationMs` (epoch 0 was genesis). */
export interface EpochTiming {
  currentEpoch: number;
  epochDurationMs: number;
  firstEpochStartMs: number;
  /** ms epoch at which the storage period ending at `endEpoch` runs out (the start of that epoch). */
  endsAt(endEpoch: number): number;
}

/** A blob object as this key sees it on chain: what an extension is addressed to. */
export interface NativeBlobState {
  found: boolean;
  owned: boolean;
  objectId: string;
  blobId?: string;
  size?: number;
  endEpoch?: number;
  startEpoch?: number;
  deletable?: boolean;
  /** Encoded size on the nodes, what storage is billed on. */
  storageSize?: number;
}

export interface NativeExtendQuote {
  state: NativeBlobState;
  timing: EpochTiming;
  epochs: number;
  amountFrost: bigint;
  amountWal: string;
}

export interface NativeWalrusUploader {
  readonly address: string;
  readonly epochs: number;
  /** Cost of a write of `size` bytes for `epochs` (default: this writer's). */
  quote(size: number, epochs?: number): Promise<NativeWalrusQuote>;
  floats(): Promise<NativeWalrusFloats>;
  upload(bytes: Uint8Array, fileName: string, log?: (line: string) => void, epochs?: number): Promise<WalrusReceipt>;
  /** Epoch number and timing, read from the chain. */
  timing(): Promise<EpochTiming>;
  /** The blob object behind an id, and whether this key owns it. */
  blobState(objectId: string): Promise<NativeBlobState>;
  /** What `epochs` more on a blob object costs now (storage only: the bytes are already on the nodes). */
  extendQuote(objectId: string, epochs?: number): Promise<NativeExtendQuote>;
  /** Buy `epochs` more on a blob object this key owns: one Sui transaction paying WAL. */
  extend(objectId: string, epochs?: number): Promise<WalrusExtendReceipt>;
}

/** Sui object ids: 0x + 64 hex. */
export const SUI_OBJECT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export function nativeWalrusUploader(o: { suiSecretKey: string; epochs?: number; rpc?: string; relay?: string; aggregator?: string }): NativeWalrusUploader {
  const keypair = Ed25519Keypair.fromSecretKey(o.suiSecretKey);
  const address = keypair.toSuiAddress();
  const epochs = o.epochs ?? WALRUS_EPOCHS;
  const aggregator = o.aggregator ?? WALRUS_AGGREGATOR;
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > 53) throw new Error(`walrus epochs must be 1..53, got ${epochs}`);
  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: o.rpc ?? SUI_RPC }).$extend(
    // The extension takes the network from the Sui client it is registered on.
    walrus({ uploadRelay: { host: o.relay ?? WALRUS_UPLOAD_RELAY, sendTip: { max: TIP_MAX_MIST } } }),
  );

  const balance = async (coinType: string) => BigInt((await client.getBalance({ owner: address, coinType })).balance.balance);

  return {
    address,
    epochs,

    async floats() {
      const [walFrost, suiMist] = await Promise.all([balance(WAL_COIN_TYPE), balance(SUI_COIN_TYPE)]);
      return { wal: nineDec(walFrost), sui: nineDec(suiMist), walFrost, suiMist };
    },

    async quote(size, n = epochs) {
      const [cost, state] = await Promise.all([client.walrus.storageCost(Math.max(size, 1), n), client.walrus.systemState()]);
      const currentEpoch = Number(state.committee?.epoch ?? 0);
      return { amountWal: nineDec(cost.totalCost), amountFrost: cost.totalCost, epochs: n, currentEpoch, endEpoch: currentEpoch + n, raw: { storageCost: cost.storageCost.toString(), writeCost: cost.writeCost.toString(), totalCost: cost.totalCost.toString() } };
    },

    async timing() {
      const st = await client.walrus.stakingState();
      const epochDurationMs = Number(st.epoch_duration);
      const firstEpochStartMs = Number(st.first_epoch_start);
      const currentEpoch = Number(st.epoch);
      return { currentEpoch, epochDurationMs, firstEpochStartMs, endsAt: (e: number) => epochEndsAt(e, firstEpochStartMs, epochDurationMs) };
    },

    async blobState(objectId) {
      if (!SUI_OBJECT_ID_RE.test(objectId)) throw new Error(`${objectId} is not a Sui object id`);
      let owner: string | undefined;
      try {
        const r = (await client.core.getObject({ objectId })) as { object?: { owner?: unknown } };
        owner = ownerAddress(r.object?.owner);
      } catch (e) {
        if (/not found|does not exist|NotFound/i.test((e as Error).message)) return { found: false, owned: false, objectId };
        throw e;
      }
      // The SDK memoises objects it has loaded; a quote and a post-extend
      // read-back must both reflect the chain now, not the object as first seen.
      client.walrus.reset();
      const blob = await client.walrus.getBlobObject(objectId).catch((e: Error) => {
        if (/not found|does not exist|NotFound/i.test(e.message)) return undefined;
        throw e;
      });
      if (!blob) return { found: false, owned: false, objectId };
      return {
        found: true,
        owned: owner === address,
        objectId,
        blobId: blobIdFromInt(blob.blob_id),
        size: Number(blob.size),
        endEpoch: Number(blob.storage.end_epoch),
        startEpoch: Number(blob.storage.start_epoch),
        deletable: blob.deletable,
        storageSize: Number(blob.storage.storage_size),
      };
    },

    async extendQuote(objectId, n = epochs) {
      const [state, timing] = await Promise.all([this.blobState(objectId), this.timing()]);
      // Extending pays storage only, on the encoded size the object already occupies; the SDK prices from the unencoded size the same way.
      const cost = state.found ? (await client.walrus.storageCost(Math.max(state.size ?? 1, 1), n)).storageCost : 0n;
      return { state, timing, epochs: n, amountFrost: cost, amountWal: nineDec(cost) };
    },

    async extend(objectId, n = epochs) {
      const q = await this.extendQuote(objectId, n);
      if (!q.state.found) throw new Error(`no blob object ${objectId} on Sui`);
      if (!q.state.owned) throw new Error(`blob object ${objectId} is not owned by ${address}`);
      const previousEndEpoch = q.state.endEpoch as number;
      const { digest } = await client.walrus.executeExtendBlobTransaction({ blobObjectId: objectId, epochs: n, signer: keypair });
      // Read the object back: the receipt reports what the chain holds, not what was asked.
      let after = await this.blobState(objectId);
      for (let i = 0; i < 5 && (after.endEpoch ?? 0) < previousEndEpoch + n; i++) {
        await sleep(2000 * (i + 1));
        after = await this.blobState(objectId);
      }
      const endEpoch = after.endEpoch ?? previousEndEpoch;
      if (endEpoch < previousEndEpoch + n) throw new Error(`extend tx ${digest} executed but the object still ends at epoch ${endEpoch} (wanted ${previousEndEpoch + n})`);
      return {
        network: 'walrus',
        op: 'extend',
        objectId,
        blobId: q.state.blobId as string,
        size: q.state.size as number,
        previousEndEpoch,
        endEpoch,
        epochs: endEpoch - previousEndEpoch,
        previousExpiresAt: q.timing.endsAt(previousEndEpoch),
        expiresAt: q.timing.endsAt(endEpoch),
        extended: `P${(endEpoch - previousEndEpoch) * EPOCH_DAYS}D`,
        provider: 'walrus-native',
        proof: { digest, owner: address, currentEpoch: q.timing.currentEpoch, amountWal: q.amountWal, explorer: `https://suivision.xyz/txblock/${digest}` },
        at: Math.floor(Date.now() / 1000),
      };
    },

    async upload(bytes, fileName, log = () => {}, n = epochs) {
      const sha = sha256Hex(bytes);
      const t0 = Date.now();
      const { blobId, blobObject } = await client.walrus.writeBlob({
        blob: bytes,
        deletable: false,
        epochs: n,
        signer: keypair,
        attributes: { name: fileName.slice(0, 200), sha256: sha },
        onStep: (step) => log(`walrus-native ${fileName}: ${step.step} (${Date.now() - t0} ms)`),
      });
      if (!blobObject.certified_epoch && blobObject.certified_epoch !== 0) throw new Error(`blob ${blobId} registered but not certified: ${JSON.stringify(blobObject)}`);

      // The aggregator may lag certification by a few seconds (and a CDN can cache a 404 briefly).
      const readUrl = `${aggregator}/v1/blobs/${blobId}`;
      let readback = 'aggregator-404';
      let verified = false;
      for (let i = 0; i < 6; i++) {
        const r = await fetch(readUrl, { cache: 'no-store', signal: AbortSignal.timeout(60_000) }).catch((e: Error) => ({ ok: false, status: 0, statusText: e.message, arrayBuffer: async () => new ArrayBuffer(0) }));
        if (r.ok) {
          const got = sha256Hex(new Uint8Array(await r.arrayBuffer()));
          verified = got === sha;
          readback = verified ? 'aggregator-sha256-match' : `aggregator-sha256-mismatch(${got.slice(0, 12)})`;
          break;
        }
        readback = `aggregator-${r.status || 'error'}`;
        if (r.status !== 404 && r.status !== 0) break;
        await sleep(3000 * (i + 1));
      }
      if (!verified) throw new Error(`blob ${blobId} certified (object ${blobObject.id}) but the aggregator did not serve it back: ${readback}`);
      // The instant the period ends, so renewals can be scheduled without asking the chain again.
      const expiresAt = await this.timing().then((t) => t.endsAt(Number(blobObject.storage.end_epoch))).catch(() => undefined);

      const receipt: WalrusReceipt = {
        network: 'walrus',
        id: blobId,
        sha256: sha,
        size: bytes.length,
        retention: `P${n * EPOCH_DAYS}D`,
        provider: 'walrus-native',
        proof: {
          blobId,
          readUrl,
          objectId: blobObject.id,
          registeredEpoch: blobObject.registered_epoch,
          certifiedEpoch: blobObject.certified_epoch ?? undefined,
          startEpoch: blobObject.storage.start_epoch,
          endEpoch: blobObject.storage.end_epoch,
          deletable: 'no',
          owner: address,
          expiresAt,
          readback,
          verified: verified ? 'yes' : 'no',
        },
        at: Math.floor(Date.now() / 1000),
      };
      return receipt;
    },
  };
}
