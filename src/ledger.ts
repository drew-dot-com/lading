/**
 * The broker's ledger of Walrus records it paid Lighthouse for.
 *
 * Lighthouse lets only the paying wallet renew a record, and the broker's Base
 * key is that wallet for every upload sold through the walrus door. So the
 * broker is the one party that CAN renew, and this ledger is how it knows
 * what it holds and when each record's paid-through date falls. One JSON
 * line per record, upserted by Lighthouse record id; expiry is refreshed
 * from Lighthouse whenever a renew quote or a renewal touches the record.
 *
 * Off when LADING_DATA_DIR is unset (the doors still work; the ledger is
 * then in memory only and lost on restart).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LedgerRow {
  /** Lighthouse record id: the handle a renewal is addressed to. */
  lighthouseId: string;
  blobId: string;
  cid: string;
  sha256: string;
  size: number;
  /** Paid-through instant, ms epoch, as Lighthouse last reported it. */
  expiresAt: number;
  /** First upload, unix seconds. */
  paidAt: number;
  /** Renewals paid through this broker. */
  renewals: number;
  /** Last event that changed the row: 'upload', 'renew', 'refresh', 'seed'. */
  last: string;
  lastAt: number;
  /** Base tx of the last payment to Lighthouse, when the settlement header carried one. */
  baseTx?: string;
}

export interface Ledger {
  upsert(row: LedgerRow): void;
  get(lighthouseId: string): LedgerRow | undefined;
  byBlobId(blobId: string): LedgerRow | undefined;
  list(): LedgerRow[];
  readonly path?: string;
}

/** Fold a JSONL history into the current row per record id. Later lines win; a bad line is skipped, not fatal. */
export function foldLedger(text: string): Map<string, LedgerRow> {
  const rows = new Map<string, LedgerRow>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as LedgerRow;
      if (typeof r.lighthouseId === 'string' && r.lighthouseId) rows.set(r.lighthouseId, r);
    } catch {
      /* skip */
    }
  }
  return rows;
}

/** Days from `now` until the paid-through instant; negative once expired. */
export const daysLeft = (expiresAt: number, nowMs = Date.now()) => Math.floor((expiresAt - nowMs) / 86_400_000);

/** Rows sorted by paid-through date, soonest first. */
export const sortByExpiry = (rows: Iterable<LedgerRow>) => [...rows].sort((a, b) => a.expiresAt - b.expiresAt || a.lighthouseId.localeCompare(b.lighthouseId));

export function openLedger(dir?: string): Ledger {
  const rows = new Map<string, LedgerRow>();
  let path: string | undefined;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'walrus-ledger.jsonl');
    if (existsSync(path)) for (const [k, v] of foldLedger(readFileSync(path, 'utf8'))) rows.set(k, v);
    else writeFileSync(path, '');
  }
  return {
    path,
    upsert(row) {
      rows.set(row.lighthouseId, row);
      if (path) appendFileSync(path, JSON.stringify(row) + '\n');
    },
    get: (id) => rows.get(id),
    byBlobId: (blobId) => [...rows.values()].find((r) => r.blobId === blobId),
    list: () => sortByExpiry(rows.values()),
  };
}
