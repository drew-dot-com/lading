/**
 * The traffic log: one line per paid TOON job this gate ran, so the stats
 * door can say what went through the edge in a window and who paid for it.
 * Every door appends after its job answers (put, part, assemble, renew, a
 * Blossom upload, the renewal timer when it bought something, the canary).
 * Seeded once from the saved manifests, so a gate that ran before the log
 * existed does not start from zero.
 *
 * The numbers are honest by construction: a job is a TOON job this gate
 * paid over its one channel, the door says who paid the gate for it, and
 * `thirdParty` counts only the doors a stranger can pay (x402, blossom). The
 * canary and the renewal timer are the operator's own traffic and are
 * counted apart.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { microToUsdc } from './gate-price.js';
import type { SavedPut } from './renewals.js';

/** Doors a stranger pays. Everything else is the operator's own traffic. */
export const THIRD_PARTY_DOORS: ReadonlySet<string> = new Set(['x402', 'blossom']);

export type JobKind = 'put' | 'part' | 'assemble' | 'renew' | 'canary';

export interface TrafficEntry {
  /** ms epoch when the job finished. */
  at: number;
  /** Who paid the gate: x402 | blossom | canary | renewals | cli. */
  door: string;
  kind: JobKind;
  ok: boolean;
  /** Base units paid over ILP, as a decimal string; '0' for a reused record. */
  units: string;
  ms?: number;
  sha?: string;
  size?: number;
  legs?: string[];
  manifestTxId?: string;
  name?: string;
  /** Who paid at the boundary, when known (an x402 address, a Nostr pubkey). */
  payer?: string;
  reused?: boolean;
  /** Written from a saved manifest at first boot, not observed live. */
  seeded?: boolean;
  error?: string;
}

export interface WindowStats {
  /** The window in ms. */
  ms: number;
  since: string;
  jobs: number;
  ok: number;
  failed: number;
  reused: number;
  units: string;
  usdc: string;
  bytes: number;
  /** Jobs paid at a door a stranger can pay (x402, blossom). */
  thirdParty: number;
  byDoor: Record<string, { jobs: number; units: string }>;
  byKind: Record<string, number>;
}

export const WINDOWS: ReadonlyArray<{ key: string; ms: number }> = [
  { key: '1h', ms: 3_600_000 },
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 7 * 86_400_000 },
  { key: '30d', ms: 30 * 86_400_000 },
];

const sum = (entries: TrafficEntry[]) => entries.reduce((a, e) => a + BigInt(e.units || '0'), 0n);

export function windowStats(entries: TrafficEntry[], ms: number, now: number): WindowStats {
  const since = now - ms;
  const inWindow = entries.filter((e) => e.at > since && e.at <= now);
  const byDoor: Record<string, { jobs: number; units: bigint }> = {};
  const byKind: Record<string, number> = {};
  for (const e of inWindow) {
    byDoor[e.door] ??= { jobs: 0, units: 0n };
    byDoor[e.door].jobs += 1;
    byDoor[e.door].units += BigInt(e.units || '0');
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }
  const units = sum(inWindow);
  return {
    ms,
    since: new Date(since).toISOString(),
    jobs: inWindow.length,
    ok: inWindow.filter((e) => e.ok).length,
    failed: inWindow.filter((e) => !e.ok).length,
    reused: inWindow.filter((e) => e.reused).length,
    units: units.toString(),
    usdc: microToUsdc(units),
    bytes: inWindow.reduce((a, e) => a + (e.ok && !e.reused ? e.size ?? 0 : 0), 0),
    thirdParty: inWindow.filter((e) => THIRD_PARTY_DOORS.has(e.door)).length,
    byDoor: Object.fromEntries(Object.entries(byDoor).map(([d, v]) => [d, { jobs: v.jobs, units: v.units.toString() }])),
    byKind,
  };
}

/** The door a saved manifest came through, from its `via`; a put with none was the CLI's. */
function doorOf(saved: SavedPut): { door: string; payer?: string } {
  try {
    const via = (JSON.parse(saved.manifest.content) as { via?: { door?: string; payer?: string } }).via;
    return { door: via?.door || 'cli', ...(via?.payer ? { payer: via.payer } : {}) };
  } catch {
    return { door: 'cli' };
  }
}

/** A saved manifest as one traffic entry, dated by the manifest's signature time. */
export function entryFromSaved(sha: string, saved: SavedPut): TrafficEntry {
  const paid = (saved.paid as Array<{ price?: string | number | null }>).reduce((a, p) => a + (p?.price ? BigInt(String(p.price)) : 0n), 0n);
  const legs = saved.manifest.tags.filter((t) => t[0] === 'leg').map((t) => t[1]);
  const size = Number(saved.manifest.tags.find((t) => t[0] === 'size')?.[1] ?? 0);
  return {
    at: saved.manifest.created_at * 1000,
    ...doorOf(saved),
    kind: 'put',
    ok: !!saved.manifestTxId,
    units: paid.toString(),
    sha,
    ...(size ? { size } : {}),
    legs,
    ...(saved.manifestTxId ? { manifestTxId: saved.manifestTxId } : {}),
    ...(saved.name?.name ? { name: saved.name.name } : {}),
    seeded: true,
  };
}

/** Append-only JSON lines under the gate's home; the whole file is held in memory (a line per job, tens of KB a year at hourly). */
export class TrafficLog {
  private entries_: TrafficEntry[] = [];

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.entries_.push(JSON.parse(line) as TrafficEntry);
      } catch {
        // A torn last line from a crash mid-write: skip it, keep the rest.
      }
    }
  }

  /** True when no file existed at construction: the caller seeds it once from what it already holds. */
  get empty(): boolean {
    return !existsSync(this.path);
  }

  entries(): readonly TrafficEntry[] {
    return this.entries_;
  }

  record(e: TrafficEntry): void {
    this.entries_.push(e);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(e)}\n`);
  }

  /** Write the seed entries as the file's first lines (oldest first). Only for an empty log. */
  seed(entries: TrafficEntry[]): number {
    if (!this.empty) return 0;
    const sorted = [...entries].sort((a, b) => a.at - b.at);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, sorted.map((e) => `${JSON.stringify(e)}\n`).join(''));
    this.entries_ = sorted;
    return sorted.length;
  }

  /** The windows, the totals, and the most recent jobs, at `now`. */
  stats(now = Date.now(), lastN = 20) {
    const all = this.entries_;
    const units = sum(all);
    return {
      at: new Date(now).toISOString(),
      windows: Object.fromEntries(WINDOWS.map((w) => [w.key, windowStats(all, w.ms, now)])),
      total: {
        jobs: all.length,
        ok: all.filter((e) => e.ok).length,
        units: units.toString(),
        usdc: microToUsdc(units),
        bytes: all.reduce((a, e) => a + (e.ok && !e.reused ? e.size ?? 0 : 0), 0),
        thirdParty: all.filter((e) => THIRD_PARTY_DOORS.has(e.door)).length,
        seeded: all.filter((e) => e.seeded).length,
        first: all.length ? new Date(Math.min(...all.map((e) => e.at))).toISOString() : null,
        last: all.length ? new Date(Math.max(...all.map((e) => e.at))).toISOString() : null,
      },
      last: [...all]
        .sort((a, b) => b.at - a.at)
        .slice(0, lastN)
        .map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    };
  }
}
