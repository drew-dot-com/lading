/**
 * The public bill of lading page: what an ArNS name serves.
 *
 * Since 0.13 a name points at an Arweave path manifest (`arweave/paths`) with
 * two entries: `index.html`, a self-contained page rendered from the signed
 * manifest, and `manifest.json`, the signed kind 30320 event itself. A browser
 * at `https://<name>.<gateway>/` sees the legs, their receipts and a button
 * that re-fetches every leg and hashes it in the browser; a program reads
 * `https://<name>.<gateway>/manifest.json`. Names made before 0.13 point at
 * the bare JSON; `manifestFromPage` and the read path in lib.ts accept both.
 *
 * The page embeds the manifest as signed BEFORE the name leg (the same bytes
 * `manifest.json` holds), so it needs no fetch to render and never disagrees
 * with the JSON beside it. It learns its own name from `location.hostname`.
 * Nothing on the page loads from anywhere else: it is permanent and must
 * outlive every host it mentions except the gateways it reads legs from.
 */
import type { Event as NostrEvent } from 'nostr-tools/pure';
import type { LegReceipt } from './kinds.js';
import { parseManifest } from './manifest.js';

export const PAGE_CONTENT_TYPE = 'text/html';
export const PATHS_CONTENT_TYPE = 'application/x.arweave-manifest+json';
/** The id of the `<script type="application/json">` the page carries the signed manifest in. */
export const EMBED_ID = 'lading-manifest';

export interface PageOptions {
  /** Every URL a leg (or a part) may be read from, in order; the page tries them in the browser. */
  readUrls: (network: string, id: string, proof?: Record<string, string | number | undefined>) => string[];
  /** The AR.IO gateway the page links raw txids on. */
  gateway: string;
  /** A hosted gate whose free `GET /v1/verify?ref=` door the page can ask for a second opinion; omitted = no button. */
  gateUrl?: string;
  /** Where the source lives, for the footer. */
  repoUrl?: string;
}

/** The `arweave/paths` manifest a name points at: `/` is the page, `/manifest.json` the signed bill. */
export function pathManifest(indexTxId: string, manifestTxId: string): string {
  return JSON.stringify({
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: 'index.html' },
    paths: { 'index.html': { id: indexTxId }, 'manifest.json': { id: manifestTxId } },
  });
}

/**
 * The signed manifest out of whatever a name served: the bare JSON (a name
 * from before 0.13) or the page with the JSON embedded. Throws when it is
 * neither.
 */
export function manifestFromPage(text: string): NostrEvent {
  const t = text.trimStart();
  if (t.startsWith('{')) return JSON.parse(t) as NostrEvent;
  const m = t.match(new RegExp(`<script[^>]*id="${EMBED_ID}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) throw new Error('neither a manifest nor a bill of lading page');
  return JSON.parse(m[1]) as NostrEvent;
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
/** JSON that is safe inside a <script> block: no `<` survives, so `</script` and `<!--` cannot occur. */
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`);
const RETENTION: Record<string, string> = { permanent: 'permanent', 'per-epoch': 'per epoch, while the broker’s runway lasts' };
const fmtRetention = (r: string) => RETENTION[r] ?? (/^P\d+D$/.test(r) ? `${r.slice(1, -1)} days from the write` : r);
const NETWORK_NAME: Record<string, string> = { arweave: 'Arweave', walrus: 'Walrus', filecoin: 'Filecoin', ipfs: 'IPFS' };

/** Proof values worth a link: a Base tx, a Sui object, anything already a URL. */
function proofValue(key: string, value: string | number | undefined): string {
  const v = String(value ?? '');
  if (/^https?:\/\//.test(v)) return `<a href="${esc(v)}">${esc(v)}</a>`;
  if (key === 'baseTx' && /^0x[0-9a-fA-F]{64}$/.test(v)) return `<a href="https://basescan.org/tx/${esc(v)}">${esc(v)}</a>`;
  if (key === 'objectId' && /^0x[0-9a-fA-F]{64}$/.test(v)) return `<a href="https://suivision.xyz/object/${esc(v)}">${esc(v)}</a>`;
  return esc(v);
}

function proofTable(proof: Record<string, string | number | undefined> | undefined): string {
  const rows = Object.entries(proof ?? {}).filter(([, v]) => v !== undefined && v !== '');
  if (rows.length === 0) return '';
  return `<table class="proof">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${proofValue(k, v)}</td></tr>`).join('')}</table>`;
}

function legSection(leg: LegReceipt, readUrls: PageOptions['readUrls']): string {
  const urls = readUrls(leg.network, leg.id, leg.proof);
  const idLink = urls[0] ? `<a href="${esc(urls[0])}">${esc(leg.id)}</a>` : `<span>${esc(leg.id)}</span>`;
  const parts = leg.parts
    ? `<details><summary>${leg.parts.length} parts</summary><ol class="parts">${leg.parts
        .map((p) => {
          const pu = readUrls(leg.network, p.id, p.proof);
          return `<li>${pu[0] ? `<a href="${esc(pu[0])}">${esc(p.id)}</a>` : esc(p.id)} <small>${fmtBytes(p.size)}, sha256 ${esc(p.sha256.slice(0, 12))}…</small> <span class="status" data-row="${esc(`${leg.network}#${p.index}`)}"></span>${proofTable(p.proof)}</li>`;
        })
        .join('')}</ol></details>`
    : '';
  return `<section class="leg" data-network="${esc(leg.network)}">
<h2>${esc(NETWORK_NAME[leg.network] ?? leg.network)} <span class="status" data-row="${esc(leg.network)}"></span></h2>
<dl>
<dt>id</dt><dd class="id">${idLink}</dd>
<dt>retention</dt><dd>${esc(fmtRetention(leg.retention))}</dd>
<dt>provider</dt><dd>${esc(leg.provider)}</dd>
<dt>written</dt><dd>${esc(new Date(leg.at * 1000).toISOString().replace('T', ' ').slice(0, 19))} UTC</dd>
${leg.paid ? `<dt>paid on TOON</dt><dd>${esc(leg.paid)} units</dd>` : ''}
</dl>
${parts}
${leg.proof ? `<details><summary>receipt</summary>${proofTable(leg.proof)}</details>` : ''}
</section>`;
}

/** Render the page for a signed manifest. Throws on an unsigned or tampered event, so a page never vouches for what it cannot check. */
export function renderPage(manifest: NostrEvent, o: PageOptions): string {
  const m = parseManifest(manifest);
  const reads: Record<string, string[]> = {};
  for (const leg of m.legs) {
    reads[leg.network] = o.readUrls(leg.network, leg.id, leg.proof);
    for (const p of leg.parts ?? []) reads[`${leg.network}#${p.index}`] = o.readUrls(leg.network, p.id, p.proof);
  }
  const archived = new Date(m.created * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const title = `Bill of lading ${m.sha256.slice(0, 12)}`;
  const legs = m.legs.map((l) => legSection(l, o.readUrls)).join('\n');
  const via = m.via ? `<dt>door</dt><dd>${esc(m.via.door)}${m.via.payer ? `, paid by ${esc(m.via.payer)}${m.via.network ? ` on ${esc(m.via.network)}` : ''}` : ''}</dd>` : '';
  const partsNote = m.legs.some((l) => l.parts) ? ` in ${Math.max(...m.legs.map((l) => l.parts?.length ?? 1))} parts` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Bill of lading for sha256 ${esc(m.sha256)}: ${m.legs.length} storage network${m.legs.length === 1 ? '' : 's'}, each with its own receipt, signed by the payer.">
<style>
:root{--bg:#EDE6D3;--ink:#1B1F26;--gold:#B89A52;--ok:#3d7a3d;--bad:#a33a2a;--line:rgba(27,31,38,.25);--card:rgba(255,255,255,.45)}
@media(prefers-color-scheme:dark){:root{--bg:#1B1F26;--ink:#EDE6D3;--line:rgba(237,230,211,.25);--card:rgba(255,255,255,.05);--ok:#7fc27f;--bad:#e3846f}}
html{background:var(--bg);color:var(--ink)}
body{margin:0;font:15px/1.5 "IBM Plex Mono","Courier New",Courier,monospace;padding:2rem 1rem 4rem;max-width:64rem;margin-inline:auto}
a{color:inherit;text-decoration-color:var(--gold);text-underline-offset:.15em;overflow-wrap:anywhere}
h1{font-size:1.6rem;margin:0 0 .25rem;font-weight:600}
h1 small{display:block;font-size:.9rem;font-weight:400;opacity:.8;overflow-wrap:anywhere}
h2{font-size:1.1rem;margin:0 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
.mark{display:inline-grid;grid-template-columns:repeat(2,.55rem);gap:.15rem;vertical-align:-.1rem;margin-right:.5rem}
.mark i{display:block;width:.55rem;height:.55rem;background:var(--ink)}.mark i:nth-child(2){background:var(--gold)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem;margin:0}dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere}
.object,.leg{background:var(--card);border:1px solid var(--line);padding:1rem;margin:1rem 0;border-radius:4px}
.legs{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))}
.leg{margin:0}
details{margin-top:.5rem}summary{cursor:pointer;opacity:.8}
table.proof{border-collapse:collapse;margin-top:.5rem;font-size:.85rem;width:100%}table.proof th{text-align:left;opacity:.7;padding:.1rem .6rem .1rem 0;vertical-align:top;white-space:nowrap}table.proof td{overflow-wrap:anywhere;padding:.1rem 0}
ol.parts{padding-left:1.4rem;font-size:.9rem}ol.parts li{margin:.3rem 0;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:1.2rem 0}
button{font:inherit;background:var(--ink);color:var(--bg);border:0;padding:.5rem .9rem;border-radius:3px;cursor:pointer}button:disabled{opacity:.5;cursor:default}
button.gold{background:var(--gold);color:#1B1F26}
.status{font-size:.85rem;font-weight:400}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.status.busy{opacity:.7}
#verdict{font-weight:600;margin:.5rem 0}#verdict.ok{color:var(--ok)}#verdict.bad{color:var(--bad)}
#log{font-size:.8rem;white-space:pre-wrap;opacity:.8;max-height:14rem;overflow:auto;margin:0}
footer{margin-top:2.5rem;font-size:.85rem;opacity:.8;border-top:1px solid var(--line);padding-top:1rem}
</style>
</head>
<body>
<header>
<h1><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Bill of lading <small id="name"></small></h1>
<p>One object, ${m.legs.length} storage network${m.legs.length === 1 ? '' : 's'}${partsNote}. Every leg below carries the receipt its network handed back; nothing here is a promise.</p>
</header>
<section class="object">
<dl>
<dt>sha256</dt><dd>${esc(m.sha256)}</dd>
<dt>size</dt><dd>${esc(fmtBytes(m.size))} (${m.size} bytes)</dd>
${m.mime ? `<dt>type</dt><dd>${esc(m.mime)}</dd>` : ''}
<dt>archived</dt><dd>${esc(archived)} UTC</dd>
<dt>signed by</dt><dd>${esc(manifest.pubkey)} <small>(Nostr, kind ${manifest.kind})</small></dd>
${via}
<dt>this document</dt><dd><a href="manifest.json">manifest.json</a>, the signed event <span>${esc(manifest.id)}</span></dd>
</dl>
</section>
<div class="actions">
<button id="verify" class="gold">Verify in this browser</button>
${o.gateUrl ? `<button id="ask">Ask the gate</button>` : ''}
<span id="verdict"></span>
</div>
<pre id="log" hidden></pre>
<div class="legs">
${legs}
</div>
<footer>
<p>Archived through <a href="https://toon.permagate.io/">TOON</a> by Lading${o.repoUrl ? ` (<a href="${esc(o.repoUrl)}">source</a>)` : ''}. Paid once at the door; each network was paid its own way and answered with its own receipt, or was not bought. The page you are reading and the manifest beside it are on Arweave under this ArNS name.</p>
</footer>
<script id="${EMBED_ID}" type="application/json">${jsonForScript(manifest)}</script>
<script id="lading-reads" type="application/json">${jsonForScript(reads)}</script>
<script>
(function(){
  var manifest = JSON.parse(document.getElementById('${EMBED_ID}').textContent);
  var reads = JSON.parse(document.getElementById('lading-reads').textContent);
  var content = JSON.parse(manifest.content);
  var nameEl = document.getElementById('name');
  var host = location.hostname;
  nameEl.textContent = /^[a-z0-9-]+_[a-z0-9-]+\\./.test(host) ? host.split('.')[0] : host;
  var logEl = document.getElementById('log'), verdict = document.getElementById('verdict');
  function log(s){ logEl.hidden = false; logEl.textContent += s + '\\n'; }
  function status(row, cls, text){ var els = document.querySelectorAll('.status[data-row="' + row + '"]'); for (var i = 0; i < els.length; i++) { els[i].className = 'status ' + cls; els[i].textContent = text; } }
  function hex(buf){ var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  function sha256(bytes){ return crypto.subtle.digest('SHA-256', bytes).then(hex); }
  function hostOf(u){ return u.replace(/^https?:\\/\\//, '').split('/')[0]; }
  function readFirst(urls){
    var tried = [];
    var i = 0;
    function next(){
      if (i >= urls.length) return Promise.resolve({ tried: tried });
      var u = urls[i++];
      // A body that dies mid-read (a gateway terminating a long transfer) is as
      // much a miss as a refused connection: note it and try the next URL.
      return fetch(u, { cache: 'no-store' }).then(function(r){
        if (!r.ok) { tried.push(hostOf(u) + ' ' + r.status); return next(); }
        return r.arrayBuffer().then(function(b){ tried.push(hostOf(u) + ' ' + r.status); return { url: u, bytes: new Uint8Array(b), tried: tried }; },
          function(){ tried.push(hostOf(u) + ' ' + r.status + ' terminated'); return next(); });
      }, function(){ tried.push(hostOf(u) + ' unreachable (CORS or down)'); return next(); });
    }
    return next();
  }
  function concat(parts){ var n = 0; parts.forEach(function(p){ n += p.length; }); var out = new Uint8Array(n), o = 0; parts.forEach(function(p){ out.set(p, o); o += p.length; }); return out; }
  function verifyLeg(leg){
    if (!leg.parts) {
      status(leg.network, 'busy', 'reading\\u2026');
      return readFirst(reads[leg.network] || []).then(function(r){
        if (!r.bytes) { status(leg.network, 'bad', '\\u2717 unread: ' + r.tried.join(', ')); log(leg.network + ': ' + r.tried.join(', ')); return false; }
        return sha256(r.bytes).then(function(h){ var ok = h === content.sha256; status(leg.network, ok ? 'ok' : 'bad', ok ? '\\u2713 sha256 match via ' + hostOf(r.url) : '\\u2717 sha256 mismatch from ' + hostOf(r.url)); log(leg.network + ': ' + r.tried.join(', ') + (ok ? ' match' : ' got ' + h.slice(0, 12))); return ok; });
      });
    }
    var got = [];
    var chain = Promise.resolve(true);
    leg.parts.forEach(function(p){
      chain = chain.then(function(okSoFar){
        var row = leg.network + '#' + p.index;
        status(row, 'busy', 'reading\\u2026');
        return readFirst(reads[row] || []).then(function(r){
          if (!r.bytes) { status(row, 'bad', '\\u2717 unread: ' + r.tried.join(', ')); return false; }
          return sha256(r.bytes).then(function(h){ var ok = h === p.sha256; status(row, ok ? 'ok' : 'bad', ok ? '\\u2713 via ' + hostOf(r.url) : '\\u2717 mismatch'); if (ok) got[p.index] = r.bytes; return okSoFar && ok; });
        });
      });
    });
    return chain.then(function(ok){
      if (!ok || got.length !== leg.parts.length) { status(leg.network, 'bad', '\\u2717 parts missing'); return false; }
      return sha256(concat(got)).then(function(h){ var m = h === content.sha256; status(leg.network, m ? 'ok' : 'bad', m ? '\\u2713 ' + leg.parts.length + ' parts reassembled, sha256 match' : '\\u2717 reassembled sha256 mismatch'); return m; });
    });
  }
  var btn = document.getElementById('verify');
  btn.addEventListener('click', function(){
    btn.disabled = true; verdict.className = ''; verdict.textContent = 'verifying\\u2026'; logEl.textContent = '';
    var all = true;
    var chain = Promise.resolve();
    content.legs.forEach(function(leg){ chain = chain.then(function(){ return verifyLeg(leg).then(function(ok){ all = all && ok; }); }); });
    chain.then(function(){ verdict.className = all ? 'ok' : 'bad'; verdict.textContent = all ? 'ALL LEGS VERIFIED in this browser' : 'NOT VERIFIED here (a gateway may refuse cross-origin reads; try the gate)'; },
      function(e){ verdict.className = 'bad'; verdict.textContent = 'verification stopped: ' + (e && e.message ? e.message : e); log('error: ' + e); })
      .then(function(){ btn.disabled = false; });
  });
  var ask = document.getElementById('ask');
  if (ask) ask.addEventListener('click', function(){
    var url = ${jsonForScript(o.gateUrl ?? '')} + '/v1/verify?ref=' + encodeURIComponent(location.hostname.split('.')[0]);
    ask.disabled = true; verdict.className = ''; verdict.textContent = 'asking the gate (it re-reads every leg; a minute or two)\\u2026';
    fetch(url).then(function(r){ return r.json(); }).then(function(v){
      (v.rows || []).forEach(function(row){ status(row.label.replace(/#(\\d+)$/, function(_, n){ return '#' + (Number(n) - 1); }), row.ok ? 'ok' : 'bad', (row.ok ? '\\u2713 ' : '\\u2717 ') + row.detail + ' (gate)'); });
      verdict.className = v.ok ? 'ok' : 'bad'; verdict.textContent = v.ok ? 'ALL LEGS VERIFIED by the gate' : 'gate: VERIFICATION FAILED';
    }, function(e){ verdict.className = 'bad'; verdict.textContent = 'the gate did not answer: ' + e; window.open(url, '_blank'); }).then(function(){ ask.disabled = false; });
  });
})();
</script>
</body>
</html>
`;
}
