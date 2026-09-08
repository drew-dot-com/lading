#!/usr/bin/env node
/**
 * The Lading command line, a thin layer over lib.ts.
 *
 *   lading put <file>       archive: arweave leg → walrus leg → filecoin leg → ipfs leg →
 *                           sign the bill of lading → publish to relay → write
 *                           it to Arweave → name it on ArNS. Each leg is one paid job per
 *                           part (an object over one packet travels as parts, see
 *                           parts.ts); a part that fails buys nothing downstream, and the
 *                           parts already bought are saved so a re-run resumes, not re-buys.
 *   lading verify <ref>     re-fetch every leg named in a manifest and compare
 *                           sha256. <ref> is an ArNS name, a manifest txId, or
 *                           a path to a saved manifest.
 *   lading name <sha>       retry the ArNS name leg for a saved manifest whose
 *                           earlier name job failed, without re-uploading.
 *   lading page <sha|all>   give a saved put its public bill of lading page: write
 *                           the page and the path manifest to Arweave and point the
 *                           name at them (a name from before 0.13 serves bare JSON).
 *   lading quote <file>     the full bill before paying it: every route's price
 *                           plus each leg's quote (deliverable right now, and
 *                           the downstream cost the broker will carry).
 *   lading renewals         every Walrus record in the saved manifests with its
 *                           paid-through date; --within <days> (default 60) marks
 *                           what is due; --live asks Lighthouse for today's date.
 *   lading renew <sha|id>   buy one more year on Walrus for a saved put's records
 *                           (or one Lighthouse record id) through the renew door,
 *                           quote first; the saved file records the new date.
 *   lading describe         what the node serves.
 *   lading mcp --gate <url> run the MCP shim over stdio: tools for Claude that
 *                           pay a hosted Lading gate per call with the Base key in
 *                           LADING_X402_KEY (see mcp.ts).
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_PART_BYTES } from './parts.js';
import { fmtDate } from './renewals.js';
import { Lading, optionsFromEnv, partLabel } from './lib.js';
import { installLongFetch } from './long-fetch.js';
installLongFetch();

const flag = (name: string) => process.argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const partBytes = () => {
  const n = Number(opt('part-bytes') ?? DEFAULT_PART_BYTES);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--part-bytes must be a positive integer, got ${opt('part-bytes')}`);
  return n;
};

const lading = new Lading(optionsFromEnv());
const { gateway, home } = lading.opts;

async function put(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const r = await lading.put(bytes, {
    name: opt('name') ?? basename(file),
    mime: opt('mime'),
    undername: opt('undername'),
    partBytes: partBytes(),
    quote: !flag('no-quote'),
    force: flag('force'),
    skip: { arweave: flag('skip-arweave'), walrus: flag('skip-walrus'), filecoin: flag('skip-filecoin'), ipfs: flag('skip-ipfs'), relay: flag('skip-relay'), name: flag('skip-name') },
  });
  console.log(r.reused ? `\nBILL OF LADING (already archived ${new Date(r.archivedAt * 1000).toISOString().slice(0, 10)}, nothing bought; --force archives again)` : '\nBILL OF LADING');
  for (const l of r.legs) console.log(`  ${l.network.padEnd(8)} ${l.id}  ${l.retention}${l.parts ? `  (${l.parts.length} parts)` : ''}`);
  if (r.manifestUrl) console.log(`  manifest ${r.manifestUrl}`);
  if (r.name) console.log(`  name     ${r.name.url}`);
  console.log(`  paid     ${r.total} base units across ${r.paid.length} jobs (${r.paid.map((p) => `${p.leg}=${p.price ?? '?'}`).join(' ')})`);
  console.log(`  saved    ${r.savedPath}`);
}

async function verify(ref: string) {
  const v = await lading.verify(ref);
  console.log(`manifest by ${v.pubkey} for sha256 ${v.sha256} (${v.size} bytes), ${v.legs} legs, read from ${v.source}`);
  for (const row of v.rows) console.log(`  ${row.label.padEnd(8)} ${row.id}  ${row.ok ? '✓' : '✗'} ${row.detail}`);
  console.log(v.ok ? 'ALL LEGS VERIFIED' : 'VERIFICATION FAILED');
  process.exitCode = v.ok ? 0 : 1;
}

async function renewals() {
  const within = Number(opt('within') ?? 60);
  const { rows, due } = await lading.renewals({ within, live: flag('live') });
  if (rows.length === 0) {
    console.log(`no walrus records under ${join(home, 'manifests')}`);
    return;
  }
  console.log(`${rows.length} walrus records${flag('live') ? ', dates from Lighthouse now' : ', dates as of the last write or renewal'}; due = within ${within} days\n`);
  console.log(`  ${'due'.padEnd(4)} ${'paid through'.padEnd(12)} ${'days'.padStart(5)}  ${'object'.padEnd(12)} ${'part'.padEnd(6)} ${'blobId'.padEnd(43)} ${'lighthouse record'.padEnd(36)} renewals  name`);
  for (const r of rows) {
    const d = Number.isNaN(r.daysLeft) ? 'GONE' : r.daysLeft <= within ? 'DUE' : '';
    console.log(`  ${d.padEnd(4)} ${fmtDate(r.expiresAt).padEnd(12)} ${String(Number.isNaN(r.daysLeft) ? '-' : r.daysLeft).padStart(5)}  ${r.sha256.slice(0, 12)} ${partLabel(r).padEnd(6)} ${r.blobId.padEnd(43)} ${r.lighthouseId.padEnd(36)} ${String(r.renewals).padStart(8)}  ${r.name ?? ''}`);
  }
  if (due.length) console.log(`\n${due.length} due: lading renew ${[...new Set(due.map((r) => r.sha256))].map((s) => s.slice(0, 12)).join(' / ')}`);
}

async function renew(ref: string) {
  const r = await lading.renew(ref, { quote: !flag('no-quote') });
  console.log(`\nrenewed ${r.bought} of ${r.targets} records, paid ${r.total} base units`);
}

async function page(ref: string) {
  const shas = ref === 'all' ? lading.savedPuts().filter((p) => p.saved.manifestTxId).map((p) => p.sha) : [ref];
  if (shas.length === 0) throw new Error(`no saved puts under ${join(home, 'manifests')}`);
  let done = 0;
  for (const sha of shas) {
    console.log(`\n${sha}`);
    try {
      const r = await lading.pageOnly(sha, { quote: !flag('no-quote'), skipRelay: flag('skip-relay'), force: flag('force') });
      if (!r.already) done++;
      console.log(`  page     ${r.name?.url ?? `https://${gateway}/${r.pathsTxId}/`}  (page ${r.pageTxId}, paths ${r.pathsTxId})`);
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`);
      if (ref !== 'all') throw e;
    }
  }
  if (ref === 'all') console.log(`\n${done} of ${shas.length} saved puts given a page`);
}

async function describe() {
  for (const { key, route, price } of await lading.describe()) console.log(`${key.padEnd(12)} ${route.padEnd(30)} ${price === null ? 'not priced' : `${price} base units`}`);
}

async function quote(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const q = await lading.quote(bytes, { name: opt('name') ?? basename(file), undername: opt('undername'), partBytes: partBytes() });
  console.log(`\n${file}: ${q.size} bytes, sha256 ${q.sha256}${q.parts > 1 ? `, ${q.parts} parts of up to ${q.largestPart} bytes` : ''}`);
  for (const { leg, route, price, note } of q.rows) console.log(`  ${leg.padEnd(13)} ${route.padEnd(30)} ${String(price ?? '?').padStart(8)}  ${note}`);
  console.log(`  ${'total'.padEnd(13)} ${''.padEnd(30)} ${q.total.toString().padStart(8)}  base units (${(Number(q.total) / 1e6).toFixed(4)} USDC), quotes paid now: ${q.quotesPaid}`);
}

async function mcp() {
  const gate = opt('gate') ?? process.env.LADING_GATE_URL;
  if (!gate) throw new Error('lading mcp needs --gate <url> (or LADING_GATE_URL)');
  const { runMcp, defaultKeyFile } = await import('./mcp.js');
  // A key from the environment wins; otherwise LADING_X402_KEY_FILE (or ~/.lading/x402.key with --autokey, generated when missing).
  const keyFile = process.env.LADING_X402_KEY_FILE ?? (flag('autokey') ? defaultKeyFile() : undefined);
  await runMcp({ gate, key: process.env.LADING_X402_KEY, keyFile, autoKey: flag('autokey'), maxUsdc: process.env.LADING_MAX_USDC_PER_CALL ?? '0.50', callBudgetS: Number(process.env.LADING_CALL_BUDGET_S ?? 45) });
}

const [cmd, arg] = process.argv.slice(2);
const run =
  cmd === 'put' && arg ? put(arg)
  : cmd === 'quote' && arg ? quote(arg)
  : cmd === 'verify' && arg ? verify(arg)
  : cmd === 'name' && arg ? lading.nameOnly(arg, { undername: opt('undername'), quote: !flag('no-quote'), skipRelay: flag('skip-relay') }).then(() => undefined)
  : cmd === 'page' && arg ? page(arg)
  : cmd === 'renewals' ? renewals()
  : cmd === 'renew' && arg ? renew(arg)
  : cmd === 'describe' ? describe()
  : cmd === 'mcp' ? mcp()
  : null;
if (!run) {
  console.log(
    'usage: lading put <file> [--name n] [--mime m] [--undername u] [--part-bytes n] [--no-quote] [--force] [--skip-arweave|--skip-walrus|--skip-filecoin|--skip-ipfs|--skip-relay|--skip-name]\n' +
      '       lading quote <file> [--part-bytes n]\n' +
      '       lading verify <arns-name|manifest-txid|saved.json>\n' +
      '       lading name <sha256> [--no-quote]\n' +
      '       lading page <sha256|all> [--no-quote] [--force]   (write the bill of lading page + path manifest, point the name at them; --force re-renders an existing page)\n' +
      '       lading renewals [--within days] [--live]\n' +
      '       lading renew <sha256|lighthouse-record-id> [--no-quote]\n' +
      '       lading describe\n' +
      '       lading mcp --gate <url> [--autokey]          (LADING_X402_KEY pays; LADING_MAX_USDC_PER_CALL caps a call, default 0.50)',
  );
  process.exit(2);
}
run
  .then(async () => {
    if (cmd !== 'mcp') await lading.close();
  })
  .catch((e) => {
    console.error('error:', e?.message ?? e);
    process.exit(1);
  });
