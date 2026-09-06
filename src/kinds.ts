/**
 * Lading's NIP-90 kinds. 5094–5098 are the org's block (store, arns, gas),
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
  /** 'permanent' or an ISO-8601 duration / epoch count the network committed to. */
  retention: string;
  /** Anything a third party can check: a Sui object id, a deal id, a gateway URL. */
  proof?: Record<string, string | number | undefined>;
  /** Who executed the leg: 'toon-store', 'lighthouse-x402', 'walrus-native'. */
  provider: string;
  /** Base units the payer sent on the TOON route for this leg, when known. */
  paid?: string;
  at: number;
}

/** What the Walrus door answers with. */
export interface WalrusReceipt extends LegReceipt {
  network: 'walrus';
  proof: { blobId: string; readUrl: string; readback?: string; cid?: string; baseTx?: string; [k: string]: string | number | undefined };
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
