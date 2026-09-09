/**
 * The payer's view of what it has on Walrus and when each record runs out.
 * Reads the saved manifests under ~/.lading/manifests: each walrus leg (or
 * each part of a chunked one) carries its handle, a Lighthouse record id or
 * the Sui blob object id of a native write, and the paid-through instant the
 * door reported at write time; a renewal or extension paid later through
 * `lading renew` is appended to the saved file and moves the date.
 */
import type { Event as NostrEvent } from 'nostr-tools/pure';
import type { LegReceipt } from './kinds.js';
import { daysLeft } from './ledger.js';

export interface RenewalRow {
  sha256: string;
  /** Which slice of the object this record holds: 0-based part index, or -1 for a whole object. */
  part: number;
  parts: number;
  blobId: string;
  /** Who holds the record and what renews it: a Lighthouse record id, or the Sui blob object id for a native write. */
  provider: 'lighthouse' | 'native';
  handle: string;
  /** Kept for readers of the older shape; empty for a native record. */
  lighthouseId: string;
  objectId?: string;
  size: number;
  /** ms epoch as of the latest record we hold (write time, or the last renewal); 0 when the record never carried one. */
  expiresAt: number;
  /** The storage period's end epoch, native records only. */
  endEpoch?: number;
  renewals: number;
  /** NaN when no date is known (a native record from before expiresAt went on the receipt; `--live` fills it in). */
  daysLeft: number;
  name?: string;
  /** The period bought at write time, in days, from the leg's `retention` (P28D = 28): what the caller chose. Unset for an older or unparsed receipt. */
  chosenDays?: number;
}

/** Days in an ISO-8601 `PnD` retention, or undefined for anything else. */
export const retentionDays = (retention: string | undefined): number | undefined => {
  const m = /^P(\d+)D$/.exec(retention ?? '');
  return m ? Number(m[1]) : undefined;
};

/** A renewal the payer bought, as appended to the saved manifest file. Lighthouse rows carry `lighthouseId`, native rows `objectId` + epochs. */
export interface SavedRenewal {
  network: 'walrus';
  lighthouseId?: string;
  objectId?: string;
  blobId: string;
  previousExpiresAt: number;
  expiresAt: number;
  previousEndEpoch?: number;
  endEpoch?: number;
  route: string;
  price: string | null;
  baseTx?: string;
  /** Sui tx digest of a native extension. */
  digest?: string;
  at: number;
}

export interface SavedPut {
  manifest: NostrEvent;
  manifestTxId?: string;
  /** The rendered bill of lading page and the path manifest the name points at (0.13+). */
  pageTxId?: string;
  pathsTxId?: string;
  name?: { name: string; url: string };
  paid: unknown[];
  renewals?: SavedRenewal[];
}

/** The renewable records in one saved put, with the latest expiry we know. */
export function walrusRecords(saved: SavedPut, nowMs = Date.now()): RenewalRow[] {
  const content = JSON.parse(saved.manifest.content) as { sha256: string; legs: LegReceipt[] };
  const out: RenewalRow[] = [];
  for (const leg of content.legs) {
    if (leg.network !== 'walrus') continue;
    const slices = leg.parts ? leg.parts.map((p) => ({ part: p.index, id: p.id, size: p.size, proof: p.proof })) : [{ part: -1, id: leg.id, size: leg.size, proof: leg.proof }];
    for (const s of slices) {
      const lighthouseId = String(s.proof?.lighthouseId ?? '');
      const objectId = String(s.proof?.objectId ?? '');
      if (!lighthouseId && !objectId) continue;
      const provider = lighthouseId ? 'lighthouse' : 'native';
      const handle = lighthouseId || objectId;
      let expiresAt = Number(s.proof?.expiresAt ?? 0);
      let endEpoch = s.proof?.endEpoch === undefined ? undefined : Number(s.proof.endEpoch);
      let renewals = 0;
      for (const r of saved.renewals ?? []) {
        if ((provider === 'lighthouse' ? r.lighthouseId : r.objectId) !== handle) continue;
        renewals++;
        if (r.expiresAt > expiresAt) expiresAt = r.expiresAt;
        if (r.endEpoch !== undefined && (endEpoch === undefined || r.endEpoch > endEpoch)) endEpoch = r.endEpoch;
      }
      out.push({
        sha256: content.sha256,
        part: s.part,
        parts: leg.parts?.length ?? 1,
        blobId: s.id,
        provider,
        handle,
        lighthouseId,
        ...(objectId ? { objectId } : {}),
        size: s.size,
        expiresAt,
        ...(endEpoch !== undefined ? { endEpoch } : {}),
        renewals,
        daysLeft: expiresAt > 0 ? daysLeft(expiresAt, nowMs) : Number.NaN,
        name: saved.name?.name,
        ...(retentionDays(leg.retention) !== undefined ? { chosenDays: retentionDays(leg.retention) } : {}),
      });
    }
  }
  return out;
}

/** Records due within `withinDays`, soonest first. */
export const dueWithin = (rows: RenewalRow[], withinDays: number) => rows.filter((r) => r.daysLeft <= withinDays).sort((a, b) => a.expiresAt - b.expiresAt);

export const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
