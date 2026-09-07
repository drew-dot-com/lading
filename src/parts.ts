/**
 * Chunking: an object larger than one ILP packet travels as parts.
 *
 * The connector caps a packet at 2 MiB (axum's default body limit at the
 * edge), and a blob rides inside the packet base64-encoded, so about 1.5 MiB
 * of raw object is the most one job can carry. Lading does not ask any
 * network to reassemble: each part is its own paid job on each network, with
 * the network's own id and the part's sha256 in the manifest, and a reader
 * puts the parts back together and checks the whole object's sha256. That
 * keeps every leg a leaf (the store, the Walrus door, the Filecoin door each
 * see an ordinary object) and keeps the payer's loss bound at one part.
 *
 * The functions here are pure so the boundaries are testable.
 */
import { createHash } from 'node:crypto';

/** Default raw bytes per part: comfortably under the measured per-packet ceiling once base64 is applied. */
export const DEFAULT_PART_BYTES = Number(process.env.LADING_PART_BYTES ?? 1024 * 1024);
/** A Filecoin piece is at least 127 bytes; a tail shorter than this is folded into the previous part. */
export const MIN_TAIL_BYTES = 127;

export interface PartPlan {
  index: number;
  offset: number;
  size: number;
}

export interface Part extends PartPlan {
  bytes: Uint8Array;
  sha256: string;
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Where the parts fall. One part when the object fits; otherwise `partBytes` slices with a tail that is never under MIN_TAIL_BYTES. */
export function planParts(size: number, partBytes = DEFAULT_PART_BYTES): PartPlan[] {
  if (!Number.isInteger(partBytes) || partBytes <= MIN_TAIL_BYTES) throw new Error(`part size must be an integer over ${MIN_TAIL_BYTES} bytes`);
  if (size <= partBytes) return [{ index: 0, offset: 0, size }];
  const plans: PartPlan[] = [];
  let offset = 0;
  while (offset < size) {
    const remaining = size - offset;
    // Fold a short tail into this part rather than leave a sliver no network wants.
    const take = remaining > partBytes && remaining - partBytes < MIN_TAIL_BYTES ? remaining : Math.min(partBytes, remaining);
    plans.push({ index: plans.length, offset, size: take });
    offset += take;
  }
  return plans;
}

export function splitParts(bytes: Uint8Array, partBytes = DEFAULT_PART_BYTES): Part[] {
  return planParts(bytes.length, partBytes).map((p) => {
    const slice = bytes.subarray(p.offset, p.offset + p.size);
    return { ...p, bytes: slice, sha256: sha256Hex(slice) };
  });
}

/** Put parts back in index order and check each against its recorded sha256 before concatenating. */
export function assembleParts(parts: Array<{ index: number; sha256: string; bytes: Uint8Array }>): Uint8Array {
  const sorted = [...parts].sort((a, b) => a.index - b.index);
  sorted.forEach((p, i) => {
    if (p.index !== i) throw new Error(`part ${i} missing (found index ${p.index})`);
    const got = sha256Hex(p.bytes);
    if (got !== p.sha256) throw new Error(`part ${i} sha256 ${got.slice(0, 12)} does not match the manifest's ${p.sha256.slice(0, 12)}`);
  });
  const out = new Uint8Array(sorted.reduce((n, p) => n + p.bytes.length, 0));
  let offset = 0;
  for (const p of sorted) {
    out.set(p.bytes, offset);
    offset += p.bytes.length;
  }
  return out;
}

/** The file name a part is uploaded under, so a provider's listing reads as one object in pieces. */
export const partName = (name: string, index: number, count: number) => (count === 1 ? name : `${name}.part${String(index + 1).padStart(String(count).length, '0')}of${count}`);
