import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildManifest } from './manifest.js';
import { EMBED_ID, manifestFromPage, pathManifest, renderPage, PATHS_CONTENT_TYPE } from './page.js';

const sha = 'ab'.repeat(32);
const partSha = 'cd'.repeat(32);
const manifest = buildManifest(
  {
    sha256: sha,
    size: 2_000_000,
    mime: 'image/png',
    legs: [
      { network: 'arweave', id: 'A'.repeat(43), sha256: sha, size: 2_000_000, retention: 'permanent', provider: 'toon-store', paid: '61030', at: 1_757_300_000 },
      {
        network: 'walrus',
        id: 'W'.repeat(43),
        sha256: sha,
        size: 2_000_000,
        retention: 'P364D',
        provider: 'walrus-native',
        at: 1_757_300_100,
        proof: { blobId: 'W'.repeat(43), objectId: '0x' + 'e'.repeat(64), readUrl: 'https://aggregator.walrus-mainnet.walrus.space/v1/blobs/' + 'W'.repeat(43) },
        parts: [
          { index: 0, id: 'W'.repeat(43), sha256: partSha, size: 1_048_576 },
          { index: 1, id: 'X'.repeat(43), sha256: partSha, size: 951_424, proof: { note: '</script><script>alert(1)</script>' } },
        ],
      },
    ],
    via: { door: 'https://lading.example/v1/put', payer: '0x' + '1'.repeat(40), network: 'base' },
    created: 1_757_300_200,
  },
  generateSecretKey(),
);

const readUrls = (network: string, id: string) => (network === 'arweave' ? [`https://permagate.io/${id}`, `https://arweave.net/${id}`] : [`https://agg.example/v1/blobs/${id}`]);
const html = renderPage(manifest, { readUrls, gateway: 'permagate.io', gateUrl: 'https://lading.example', repoUrl: 'https://github.com/drew-dot-com/lading' });

test('the page embeds the signed manifest verbatim and manifestFromPage gets it back', () => {
  assert.ok(html.includes(`id="${EMBED_ID}"`));
  // (nostr-tools caches a verified symbol on the object it checked; compare the wire form.)
  const wire = JSON.parse(JSON.stringify(manifest));
  assert.deepEqual(manifestFromPage(html), wire);
  // A bare JSON body (a name from before 0.13) parses too.
  assert.deepEqual(manifestFromPage(JSON.stringify(manifest)), wire);
  assert.throws(() => manifestFromPage('<html>nothing here</html>'), /neither/);
});

test('the page renders every leg, part and receipt, links reads, and escapes what the receipts carry', () => {
  assert.ok(html.includes('Arweave'));
  assert.ok(html.includes('Walrus'));
  assert.ok(html.includes('2 parts'));
  assert.ok(html.includes(`https://permagate.io/${'A'.repeat(43)}`));
  assert.ok(html.includes(`https://suivision.xyz/object/0x${'e'.repeat(64)}`));
  assert.ok(html.includes('image/png'));
  assert.ok(html.includes('paid by 0x1111'));
  // The hostile proof value never becomes markup, in the HTML or inside the embedded JSON.
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;/script&gt;'));
  const embedded = html.slice(html.indexOf(`id="${EMBED_ID}"`));
  assert.ok(!embedded.slice(0, embedded.indexOf('</script>')).includes('</script'));
  // The read urls the browser will try are embedded per row, parts included.
  const reads = JSON.parse(html.match(/id="lading-reads"[^>]*>([\s\S]*?)<\/script>/)![1]);
  assert.deepEqual(reads.arweave, [`https://permagate.io/${'A'.repeat(43)}`, `https://arweave.net/${'A'.repeat(43)}`]);
  assert.deepEqual(reads['walrus#1'], [`https://agg.example/v1/blobs/${'X'.repeat(43)}`]);
  assert.ok(html.includes('id="ask"'));
  assert.ok(!renderPage(manifest, { readUrls, gateway: 'permagate.io' }).includes('id="ask"'));
});

test('a tampered manifest gets no page', () => {
  const bad = { ...manifest, content: manifest.content.replace('"size":2000000', '"size":2000001') };
  assert.throws(() => renderPage(bad, { readUrls, gateway: 'permagate.io' }), /signature/);
});

test('the path manifest points / at the page and /manifest.json at the bill', () => {
  const p = JSON.parse(pathManifest('P'.repeat(43), 'M'.repeat(43)));
  assert.equal(p.manifest, 'arweave/paths');
  assert.equal(p.index.path, 'index.html');
  assert.equal(p.paths['index.html'].id, 'P'.repeat(43));
  assert.equal(p.paths['manifest.json'].id, 'M'.repeat(43));
  assert.equal(PATHS_CONTENT_TYPE, 'application/x.arweave-manifest+json');
});
