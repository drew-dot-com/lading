import { finalizeEvent, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { MANIFEST_KIND, type LegReceipt } from './kinds.js';

/**
 * The bill of lading. Signed by the PAYER's Nostr key, not the broker's: it is
 * the agent's own attestation of where its bytes went, carrying each network's
 * receipt. Kind 30320, `d` = sha256, so a later archive of the same bytes by
 * the same key replaces the earlier manifest.
 */
export interface ManifestContent {
  sha256: string;
  size: number;
  mime?: string;
  legs: LegReceipt[];
  /** Set once the manifest itself is on Arweave and named. */
  arns?: { undername: string; name: string; manifestTxId: string };
  created: number;
}

export function buildManifest(
  content: ManifestContent,
  secretKey: Uint8Array,
): NostrEvent {
  const tags: string[][] = [
    ['d', content.sha256],
    ['x', content.sha256],
    ['size', String(content.size)],
    ...content.legs.map((l) => (l.parts ? ['leg', l.network, l.id, l.retention, String(l.parts.length)] : ['leg', l.network, l.id, l.retention])),
  ];
  if (content.mime) tags.push(['m', content.mime]);
  if (content.arns) tags.push(['arns', content.arns.name]);
  return finalizeEvent(
    {
      kind: MANIFEST_KIND,
      created_at: content.created,
      tags,
      content: JSON.stringify(content),
    },
    secretKey,
  );
}

export function parseManifest(event: NostrEvent): ManifestContent {
  if (event.kind !== MANIFEST_KIND) throw new Error(`not a manifest: kind ${event.kind}`);
  // Verify a plain copy: nostr-tools caches a verified flag on the object it
  // checked, and a caller may hand us a mutated spread of a verified event.
  const plain = { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig };
  if (!verifyEvent(plain)) throw new Error('manifest signature invalid');
  const content = JSON.parse(event.content) as ManifestContent;
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  if (d !== content.sha256) throw new Error('manifest d tag does not match content.sha256');
  return content;
}
