// Bundle the shim into one file and pack the Claude Desktop extension (.mcpb).
// Output: dist/lading-<version>.mcpb. Nothing from node_modules ships unbundled.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`extension/manifest.json is ${manifest.version}, package.json is ${pkg.version}`);

mkdirSync('extension/server', { recursive: true });
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'extension/server/index.js',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});
// mcpb pack wants a package.json beside the manifest; a minimal one keeps the bundle honest about its version.
writeFileSync('extension/package.json', JSON.stringify({ name: 'lading-extension', version: pkg.version, private: true, type: 'module' }, null, 2) + '\n');
mkdirSync('dist', { recursive: true });
const out = `dist/lading-${pkg.version}.mcpb`;
execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack', 'extension', out], { stdio: 'inherit' });
copyFileSync(out, 'dist/lading.mcpb');
console.log(`packed ${out}`);
