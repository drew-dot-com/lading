/**
 * The canary: the gate's own put on a timer, so the path it sells is walked
 * on the hour whether or not a caller shows up. Each run archives a small,
 * unique object (its own timestamp and sequence) through the same `put` the
 * paid doors use, on the networks chosen for it (Arweave alone by default,
 * the cheapest leg and the one every bill of lading anchors to), paid over
 * the gate's channel like any job. The run before it is read back through
 * the verify door, so every tick is one write and one read of durable data,
 * and a gateway that stopped serving shows up here first.
 *
 * What it is for: a probe of the path, the edge, the store and the read
 * gateways, and a heartbeat the stats door can show. What it is not: a
 * caller. Its jobs are counted under their own door (`canary`) and never as
 * third-party traffic. The last report is kept on disk, judged as the
 * `canary` float row (not ok when the last run failed, so refuel's probe
 * raises it), and pushed to ntfy when a run fails and when the path comes
 * back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FloatRow } from './floats.js';
import { parseChoices, skipFor, type Network } from './choices.js';

/** What a run needs of the lib; `Lading` satisfies it. */
export interface CanaryLading {
  put(bytes: Uint8Array, o: { name: string; mime?: string; skip?: ReturnType<typeof skipFor>; via?: { door: string; network?: string } }): Promise<{ sha256: string; size: number; legs: Array<{ network: string; id: string }>; manifestTxId?: string; total: bigint; reused?: boolean }>;
  verify(ref: string): Promise<{ ok: boolean; rows: Array<{ label: string; ok: boolean; detail?: string }> }>;
}

export interface CanaryReport {
  /** ms epoch when the run started. */
  at: number;
  ms: number;
  seq: number;
  networks: Network[];
  ok: boolean;
  /** The put: what it wrote and what it cost. */
  put?: { sha256: string; size: number; legs: string[]; manifestTxId: string | null; units: string; ms: number };
  /** The previous run's manifest, read back through verify (absent on the first run, or when the previous run had no manifest). */
  readBack?: { ref: string; ok: boolean; ms: number; failed?: string[]; error?: string };
  error?: string;
}

export interface CanaryOptions {
  seq: number;
  networks: Network[];
  /** The gate's public URL, recorded in the object so a reader knows where it came from. */
  gate: string;
  previous?: CanaryReport;
  log?: (line: string) => void;
  /** Wraps the paid call: the gate hands its job serializer here so a canary never races a put on the one channel. */
  run?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

/** Filecoin pieces need 127 bytes and a tiny object is not worth a smaller packet: every canary object is at least this long. */
export const MIN_BYTES = 200;

/** The object: a small JSON with the run's own time and sequence, so every run is new bytes and no put is ever answered from a saved record. */
export function canaryBytes(o: { at: number; seq: number; gate: string; networks: Network[] }): Uint8Array {
  const base = { lading: 'canary', what: 'an hourly probe put by the gate itself, not a customer object', at: new Date(o.at).toISOString(), seq: o.seq, gate: o.gate, networks: o.networks };
  let text = JSON.stringify(base);
  if (text.length < MIN_BYTES) text = JSON.stringify({ ...base, pad: '.'.repeat(MIN_BYTES - text.length - 9) });
  return new TextEncoder().encode(text);
}

/** One run: put a new object, read the previous one back, report. Never throws: a failure is the report's `error`. */
export async function runCanary(lading: CanaryLading, o: CanaryOptions): Promise<CanaryReport> {
  const log = o.log ?? (() => undefined);
  const run = o.run ?? (<T>(fn: () => Promise<T>) => fn());
  const now = o.now ?? Date.now;
  const t0 = now();
  const report: CanaryReport = { at: t0, ms: 0, seq: o.seq, networks: o.networks, ok: false };
  const choices = parseChoices({ networks: o.networks.join(',') });
  // Read the previous run back first: it is free, and a put that then fails still leaves a read in the report.
  const prev = o.previous?.put?.manifestTxId;
  if (prev) {
    const t = now();
    try {
      const v = await lading.verify(prev);
      const failed = v.rows.filter((r) => !r.ok).map((r) => `${r.label}${r.detail ? `: ${r.detail.slice(0, 80)}` : ''}`);
      report.readBack = { ref: prev, ok: v.ok, ms: now() - t, ...(failed.length ? { failed } : {}) };
      log(`canary #${o.seq}: read back ${prev.slice(0, 12)}… ${v.ok ? 'ok' : `FAILED ${failed.join('; ')}`} in ${now() - t} ms`);
    } catch (e) {
      report.readBack = { ref: prev, ok: false, ms: now() - t, error: (e as Error).message.slice(0, 200) };
      log(`canary #${o.seq}: read back ${prev.slice(0, 12)}… threw: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const bytes = canaryBytes({ at: t0, seq: o.seq, gate: o.gate, networks: o.networks });
  const t = now();
  try {
    const r = await run(() => lading.put(bytes, { name: `canary-${o.seq}.json`, mime: 'application/json', skip: skipFor(choices), via: { door: 'canary' } }));
    report.put = { sha256: r.sha256, size: r.size, legs: r.legs.map((l) => l.network), manifestTxId: r.manifestTxId ?? null, units: (r.reused ? 0n : r.total).toString(), ms: now() - t };
    report.ok = !!r.manifestTxId && !r.reused && (report.readBack?.ok ?? true);
    if (r.reused) report.error = 'the put was answered from a saved record: the canary object was not new';
    else if (!r.manifestTxId) report.error = 'the put finished without a manifest on Arweave';
    else if (report.readBack && !report.readBack.ok) report.error = `the previous run's manifest did not read back: ${report.readBack.failed?.join('; ') ?? report.readBack.error}`;
    log(`canary #${o.seq}: put ${r.sha256.slice(0, 12)} ${r.size} B on ${report.put.legs.join('+') || 'nothing'} manifest=${r.manifestTxId ?? '-'} paid=${report.put.units} in ${report.put.ms} ms${report.ok ? '' : ` NOT OK: ${report.error}`}`);
  } catch (e) {
    report.error = (e as Error).message.slice(0, 300);
    log(`canary #${o.seq}: put FAILED after ${now() - t} ms: ${report.error}`);
  }
  report.ms = now() - t0;
  return report;
}

/**
 * The run as a float row: balance 1 when the last run was ok and not older
 * than two intervals, else 0; low 1. Before the first run the row is ok with
 * no balance.
 */
export function canaryRow(last: CanaryReport | undefined, o: { everyMs: number; networks: Network[]; home: string; now?: number }): FloatRow {
  const now = o.now ?? Date.now();
  const base = { name: 'canary', role: `the gate's own put every ${Math.round(o.everyMs / 60_000)} min on ${o.networks.join('+')}, and a read of the one before`, chain: 'toon', asset: 'ok', address: o.home, low: '1' };
  if (!last) return { ...base, balance: '?', ok: true, fund: 'first run pending', extra: { everyMinutes: o.everyMs / 60_000 } };
  const stale = now - last.at > 2 * o.everyMs + 60_000;
  const ok = last.ok && !stale;
  return {
    ...base,
    balance: ok ? '1' : '0',
    ok,
    fund: ok ? `last run ok; next in ${Math.max(0, Math.round((last.at + o.everyMs - now) / 60_000))} min` : stale ? `no run for ${Math.round((now - last.at) / 60_000)} min: the timer is stuck or the gate was down` : `last run failed: ${last.error ?? '?'}. Check the edge, the store and the gate payer's floats.`,
    extra: {
      lastRun: new Date(last.at).toISOString(),
      seq: last.seq,
      ms: last.ms,
      ...(last.put ? { sha256: last.put.sha256, manifestTxId: last.put.manifestTxId, paidUnits: last.put.units, legs: last.put.legs.join('+') } : {}),
      ...(last.readBack ? { readBack: last.readBack.ok ? 'ok' : 'failed', readBackRef: last.readBack.ref } : {}),
      everyMinutes: o.everyMs / 60_000,
    },
  };
}

/** The push a run earns: on a failure, and on the first success after one. Null otherwise. */
export function canaryNotification(r: CanaryReport, previous: CanaryReport | undefined): { title: string; body: string; priority: 'default' | 'high' | 'low'; tags: string } | null {
  if (!r.ok) {
    return {
      title: `lading canary #${r.seq} failed`,
      body: [`${r.error ?? 'unknown'}`, r.put ? `put ${r.put.sha256.slice(0, 12)}… manifest ${r.put.manifestTxId ?? '-'} paid ${r.put.units}` : 'no put', r.readBack ? `read back ${r.readBack.ref.slice(0, 12)}… ${r.readBack.ok ? 'ok' : 'failed'}` : ''].filter(Boolean).join('\n'),
      priority: 'high',
      tags: 'warning',
    };
  }
  if (previous && !previous.ok) {
    return { title: `lading canary back: #${r.seq} ok`, body: `put ${r.put?.sha256.slice(0, 12)}… manifest ${r.put?.manifestTxId ?? '-'} in ${r.ms} ms after #${previous.seq} failed`, priority: 'low', tags: 'white_check_mark' };
  }
  return null;
}

export function readLastCanary(path: string): CanaryReport | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CanaryReport;
  } catch {
    return undefined;
  }
}

export function writeLastCanary(path: string, r: CanaryReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2));
}
