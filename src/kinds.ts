/**
 * Lading's NIP-90 kinds. 5094 to 5098 are the org's block (store, arns, gas),
 * 5301 is anonfetch; Lading takes 5320 for a leg job and 30320 for the
 * bill of lading, a parameterized replaceable event keyed by the object's
 * sha256 so one object has one current manifest per signer.
 */
export const LEG_KIND = 5320;
export const MANIFEST_KIND = 30320;

/** A leg receipt: what one storage network handed back for one object. */
export interface LegReceipt {
  network: 'arweave' | 'walrus' | 'filecoin';
  /** The network's own id for the bytes: Arweave txId, Walrus blobId, Filecoin CID. */
  id: string;
  /** sha256 of the object, hex, computed by whoever wrote the receipt. */
  sha256: string;
  size: number;
  /** 'permanent', an ISO-8601 duration the network committed to, or 'per-epoch' (paid while the broker's runway lasts). */
  retention: string;
  /** Anything a third party can check: a Sui object id, a deal id, a gateway URL. */
  proof?: Record<string, string | number | undefined>;
  /** Who executed the leg: 'toon-store', 'lighthouse-x402', 'filecoin-onchain-cloud', 'walrus-native'. */
  provider: string;
  /** Base units the payer sent on the TOON route for this leg, when known. Summed over parts for a chunked leg. */
  paid?: string;
  at: number;
  /**
   * Present when the object travelled as parts (see parts.ts). Then `id` is
   * part 0's id, `sha256` and `size` are the whole object's, and a reader
   * fetches every part, checks each part's sha256, and concatenates in index
   * order to get the object back.
   */
  parts?: PartReceipt[];
}

/** One part of a chunked leg: the network's own id for that slice and the slice's sha256. */
export interface PartReceipt {
  index: number;
  id: string;
  sha256: string;
  size: number;
  proof?: Record<string, string | number | undefined>;
  paid?: string;
}

/** What the Walrus door answers with. */
export interface WalrusReceipt extends LegReceipt {
  network: 'walrus';
  proof: { blobId: string; readUrl: string; readback?: string; cid?: string; baseTx?: string; [k: string]: string | number | undefined };
}

/** What the Filecoin door answers with. `id` is the PieceCID; the proof names the on-chain data set and piece. */
export interface FilecoinReceipt extends LegReceipt {
  network: 'filecoin';
  retention: 'per-epoch';
  proof: {
    pieceCid: string;
    readUrl: string;
    chain: string;
    dataSetId: string;
    pieceId: string;
    providerId: string;
    readback?: string;
    txHash?: string;
    runwayDays?: string;
    [k: string]: string | number | undefined;
  };
}

/** What the name door answers with. */
export interface NameReceipt {
  undername: string;
  antId: string;
  manifestTxId: string;
  /** The fully qualified ArNS name, `<undername>_<base>`. */
  name: string;
  url: string;
  at: number;
}
