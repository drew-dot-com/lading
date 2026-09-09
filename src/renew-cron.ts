/**
 * Renewals on a timer: the payer's own records, kept paid `within` days ahead.
 *
 * One run reads every Walrus record in the saved manifests, asks the chain
 * (native) and Lighthouse (hosted) for today's paid-through date, and buys
 * more time on each record that runs out within the window: native records
 * through the extend doors (quote, then `epochs` more), Lighthouse records
 * through the renew doors (quote, then a year). Every purchase goes through
 * `renew`, so the saved file gets the new date the same way a hand renewal
 * does. What the run found and bought is one report; the gate keeps the last
 * one on disk, publishes it as a float row (`renewals`: not ok when a due
 * record is still unrenewed, so refuel's probe raises it like an empty key)
 * and pushes it to ntfy when something needs a human. The CLI runs the same
 * routine as `lading renew-due`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FloatRow } from './floats.js';
import { fmtDate, type RenewalRow } from './renewals.js';

/** The two lib calls a run needs; `Lading` satisfies it. */
export interface Renewer {
  renewals(o: { within?: number; live?: boolean }): Promise<{ rows: RenewalRow[]; due: RenewalRow[]; within: number }>;
  renew(ref: string, o?: { quote?: boolean; epochs?: number }): Promise<{ rows: Array<{ handle: string; skipped?: string; expiresAt?: number; endEpoch?: number; digest?: string; baseTx?: string }>; bought: number; total: bigint }>;
}

export interface RenewRunReport {
  /** ms epoch when the run started. */
  at: number;
  /** ms it took. */
  ms: number;
  within: number;
  /** Records seen, and how many carried a date after the live pass. */
  records: number;
  dated: number;
  /** When the live pass (chain + Lighthouse) failed and the run fell back to the saved dates. */
  liveFailed?: string;
  due: number;
  bought: Array<{ handle: string; label: string; expiresAt?: number; endEpoch?: number; tx?: string }>;
  /** Due records whose quote said not deliverable: nothing paid, still due. */
  skipped: Array<{ handle: string; label: string; reason: string }>;
  /** Due records whose renewal threw: money may have moved, the record is still due. */
  failed: Array<{ handle: string; label: string; error: string }>;
  /** Base units paid over the run, as a decimal string. */
  total: string;
  /** Days left on the soonest record after the run, when any record carries a date. */
  soonestDays: number | null;
  soonestHandle?: string;
  /** The date each record carried after the live pass (and any purchase), by handle: what the saved files may not hold yet. */
  dates?: Record<string, { expiresAt: number; endEpoch?: number }>;
}

export interface RenewDueOptions {
  /** Records within this many days of running out are renewed. */
  within: number;
  /** Epochs to buy on a native record; unset = the door's default (26, a year). */
  epochs?: number;
  log?: (line: string) => void;
  /** Wraps each paid call: the gate hands its job serializer here so a renewal never races a put on the one channel. */
  run?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

const label = (r: RenewalRow) => `${r.sha256.slice(0, 12)}${r.part >= 0 ? `#${r.part + 1}/${r.parts}` : ''} ${r.provider}`;

/** One run: date every record, renew what is due, report. Never throws for one record's sake; a failed listing is the one error that ends a run. */
export async function renewDue(lading: Renewer, o: RenewDueOptions): Promise<RenewRunReport> {
  const log = o.log ?? (() => undefined);
  const run = o.run ?? (<T>(fn: () => Promise<T>) => fn());
  const now = o.now ?? Date.now;
  const t0 = now();
  let listing: Awaited<ReturnType<Renewer['renewals']>>;
  let liveFailed: string | undefined;
  try {
    listing = await run(() => lading.renewals({ within: o.within, live: true }));
  } catch (e) {
    // The chain or Lighthouse would not answer: use the dates the saved files hold rather than skip the run.
    liveFailed = (e as Error).message.slice(0, 200);
    log(`renew-due: live dates unavailable (${liveFailed}); using saved dates`);
    listing = await lading.renewals({ within: o.within, live: false });
  }
  const { rows, due } = listing;
  const report: RenewRunReport = {
    at: t0,
    ms: 0,
    within: o.within,
    records: rows.length,
    dated: rows.filter((r) => !Number.isNaN(r.daysLeft)).length,
    ...(liveFailed ? { liveFailed } : {}),
    due: due.length,
    bought: [],
    skipped: [],
    failed: [],
    total: '0',
    soonestDays: null,
  };
  log(`renew-due: ${rows.length} records, ${report.dated} dated, ${due.length} due within ${o.within} days`);
  let total = 0n;
  const after = new Map(rows.map((r) => [r.handle, r] as const));
  for (const r of due) {
    const l = label(r);
    try {
      const res = await run(() => lading.renew(r.handle, { epochs: o.epochs }));
      total += res.total;
      const row = res.rows.find((x) => x.handle === r.handle) ?? res.rows[0];
      if (!row || row.skipped) {
        report.skipped.push({ handle: r.handle, label: l, reason: row?.skipped ?? 'no row' });
        log(`renew-due: ${l} ${r.handle} SKIPPED: ${row?.skipped ?? 'no row'}`);
        continue;
      }
      report.bought.push({ handle: r.handle, label: l, expiresAt: row.expiresAt, endEpoch: row.endEpoch, tx: row.digest ?? row.baseTx });
      if (row.expiresAt) after.set(r.handle, { ...r, expiresAt: row.expiresAt, daysLeft: Math.floor((row.expiresAt - now()) / 86_400_000), endEpoch: row.endEpoch ?? r.endEpoch });
      log(`renew-due: ${l} ${r.handle} renewed -> ${row.expiresAt ? fmtDate(row.expiresAt) : '?'}${row.endEpoch ? ` (epoch ${row.endEpoch})` : ''}`);
    } catch (e) {
      report.failed.push({ handle: r.handle, label: l, error: (e as Error).message.slice(0, 300) });
      log(`renew-due: ${l} ${r.handle} FAILED: ${(e as Error).message}`);
    }
  }
  const dated = [...after.values()].filter((r) => !Number.isNaN(r.daysLeft)).sort((a, b) => a.daysLeft - b.daysLeft);
  if (dated.length) {
    report.soonestDays = dated[0].daysLeft;
    report.soonestHandle = dated[0].handle;
  }
  report.dates = Object.fromEntries(dated.map((r) => [r.handle, { expiresAt: r.expiresAt, ...(r.endEpoch !== undefined ? { endEpoch: r.endEpoch } : {}) }]));
  report.total = total.toString();
  report.ms = now() - t0;
  log(`renew-due: done in ${report.ms} ms, bought ${report.bought.length}, skipped ${report.skipped.length}, failed ${report.failed.length}, paid ${report.total} units, soonest ${report.soonestDays ?? '?'} days`);
  return report;
}

/** True when the run left nothing for a human: every due record was renewed and the listing was live. */
export const runOk = (r: RenewRunReport) => r.failed.length === 0 && r.skipped.length === 0 && !r.liveFailed;

/**
 * The run as a float row: `balance` = days left on the soonest record, `low` =
 * the window, ok only when the last run bought everything due. Before the
 * first run the row is ok with no balance (the last report is kept on disk,
 * so that is only a brand-new gate's first minute, not worth a push).
 */
export function renewalsRow(last: RenewRunReport | undefined, o: { within: number; everyMs: number; home: string }): FloatRow {
  const base = { name: 'renewals', role: `the gate's own Walrus records, renewed ${o.within} days out on a timer`, chain: 'walrus', asset: 'days', address: o.home, low: String(o.within) };
  if (!last) return { ...base, balance: '?', ok: true, fund: 'first run pending', extra: { everyHours: o.everyMs / 3_600_000 } };
  const ok = runOk(last);
  const problems = [
    ...last.failed.map((f) => `${f.label} ${f.handle} failed: ${f.error.slice(0, 80)}`),
    ...last.skipped.map((s) => `${s.label} ${s.handle} not deliverable: ${s.reason}`),
    ...(last.liveFailed ? [`live dates unavailable: ${last.liveFailed.slice(0, 80)}`] : []),
  ];
  return {
    ...base,
    balance: last.soonestDays === null ? '?' : String(last.soonestDays),
    ok,
    fund: ok ? `nothing due; next run in ${Math.round(o.everyMs / 3_600_000)} h` : `${problems.join('; ')}. Fix the cause (a float row, the door) or run: lading renew <handle>`,
    extra: {
      lastRun: new Date(last.at).toISOString(),
      records: last.records,
      dated: last.dated,
      due: last.due,
      bought: last.bought.length,
      skipped: last.skipped.length,
      failed: last.failed.length,
      paidUnits: last.total,
      ...(last.soonestHandle ? { soonest: last.soonestHandle } : {}),
      everyHours: o.everyMs / 3_600_000,
    },
  };
}

/** The push a run earns: null when nothing moved and nothing is wrong. */
export function notification(r: RenewRunReport): { title: string; body: string; priority: 'default' | 'high' | 'low'; tags: string } | null {
  const lines: string[] = [];
  for (const b of r.bought) lines.push(`renewed ${b.label} ${b.handle.slice(0, 14)}… -> ${b.expiresAt ? fmtDate(b.expiresAt) : '?'}${b.tx ? ` tx ${b.tx.slice(0, 12)}…` : ''}`);
  for (const s of r.skipped) lines.push(`NOT DELIVERABLE ${s.label} ${s.handle.slice(0, 14)}…: ${s.reason}`);
  for (const f of r.failed) lines.push(`FAILED ${f.label} ${f.handle.slice(0, 14)}…: ${f.error.slice(0, 120)}`);
  if (r.liveFailed) lines.push(`live dates unavailable: ${r.liveFailed.slice(0, 120)}`);
  if (lines.length === 0) return null;
  const bad = !runOk(r);
  lines.push(`paid ${r.total} units; ${r.records} records, soonest ${r.soonestDays ?? '?'} days`);
  return {
    title: bad ? `lading renewals need a look (${r.failed.length} failed, ${r.skipped.length} skipped)` : `lading renewed ${r.bought.length} record${r.bought.length === 1 ? '' : 's'}`,
    body: lines.join('\n'),
    priority: bad ? 'high' : 'low',
    tags: bad ? 'warning' : 'hourglass',
  };
}

/** Push one note to ntfy (`https://ntfy.sh/<topic>`); a failure is logged, never thrown. Unset url = log only. */
export async function pushNtfy(url: string | undefined, n: { title: string; body: string; priority: string; tags: string }, log: (line: string) => void = () => undefined): Promise<boolean> {
  log(`notify${url ? '' : ' (ntfy off)'}: ${n.title}\n${n.body}`);
  if (!url) return false;
  try {
    // ntfy headers are ASCII; the body carries the text as-is.
    const r = await fetch(url, { method: 'POST', headers: { Title: n.title.replace(/[^\x20-\x7e]/g, '?'), Priority: n.priority, Tags: n.tags }, body: n.body, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
    return true;
  } catch (e) {
    log(`ntfy failed: ${(e as Error).message}`);
    return false;
  }
}

/** The last report, kept beside the manifests so a restart does not forget it. */
export function readLastRun(path: string): RenewRunReport | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RenewRunReport;
  } catch {
    return undefined;
  }
}

export function writeLastRun(path: string, r: RenewRunReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2));
}
