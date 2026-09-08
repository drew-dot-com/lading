/** The package version, read once from package.json so no door can drift from the release. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/ during tsx, dist/ after tsc; package.json is one level up either way.
    return (JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
export const VERSION = readVersion();
