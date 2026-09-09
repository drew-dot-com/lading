/**
 * What a caller may choose about an archive at the door, and how the price
 * follows. Three choices exist:
 *
 *  - `networks`: which of the four storage networks carry the object. At
 *    least one. The bill of lading itself (the signed manifest) is always
 *    anchored on Arweave; leaving `arweave` out only keeps the object's bytes
 *    off it. Every network not chosen drops from the bill with its quote
 *    door, so the price is exactly the legs bought.
 *  - `arns`: whether the bill gets a public page and an ArNS name
 *    (`l-<sha12>_<base>`), off by default since 0.17. An agent reads the
 *    manifest JSON the door returns; the page and the name are for showing a
 *    person, and the name spends one of the base name's undername slots. Set,
 *    the finish adds the page write, the path manifest, the name quote and
 *    the name leg. A put the gate already holds gets its name on a later put
 *    with `arns` set, nothing else re-bought.
 *  - `walrusEpochs`: how long Walrus keeps the object, in two-week epochs,
 *    1..53. Unset means the broker's default (26, a year, the same year the
 *    hosted writer sells). Set, it goes to the native writer; the broker's
 *    Walrus route is flat, so the gate adds a surcharge per epoch past the
 *    default (see gate-price.ts). Fewer epochs buy no discount: the fixed
 *    costs of a write (gas, the relay tip, the route) dominate a short one.
 *
 * Nothing else is a knob: Arweave is permanent, Pinata pins for a year,
 * Filecoin is paid per epoch out of the broker's deposit for as long as the
 * runway lasts. The same choices ride on every door (query on the free
 * quotes, `x-networks` / `x-walrus-epochs` / `x-arns` headers on the paid
 * puts and parts, JSON fields on assemble) and on the CLI and shim.
 */
// No lib import: the shim bundles this file and must stay light.
export type Network = 'arweave' | 'walrus' | 'filecoin' | 'ipfs';
const NETWORKS = ['arweave', 'walrus', 'filecoin', 'ipfs'] as const;

/** A choice that cannot be honoured: a 400 at the door, a plain error on the CLI and in the shim. */
export class ChoiceError extends Error {}

export interface Choices {
  networks: Network[];
  walrusEpochs?: number;
  /** A public page and an ArNS name for the bill. Absent or false: the manifest only. */
  arns?: boolean;
}

export const DEFAULT_WALRUS_EPOCHS = 26;
export const MAX_WALRUS_EPOCHS = 53;
export const EPOCH_DAYS = 14;

export const ALL_NETWORKS: Network[] = [...NETWORKS];

/** Every network, no duration set, no name: what a put without choices buys. */
export const defaultChoices = (): Choices => ({ networks: [...ALL_NETWORKS] });

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);
/** A boolean from a header, a query value, JSON or a flag; absent means false. */
function parseBool(raw: unknown, what: string): boolean {
  if (raw === undefined || raw === null || raw === '') return false;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  throw new ChoiceError(`${what} must be true or false, got ${String(raw)}`);
}

const isNetwork = (s: string): s is Network => (NETWORKS as readonly string[]).includes(s);

/**
 * Validate what a caller sent. `networks` may be a comma list or an array;
 * empty or absent means all four. `walrusEpochs` absent means the broker's
 * default. `arns` absent means no page and no name. Anything else is a
 * ChoiceError (a 400 at the door).
 */
export function parseChoices(raw: { networks?: unknown; walrusEpochs?: unknown; arns?: unknown } = {}): Choices {
  let networks: Network[];
  const n = raw.networks;
  if (n === undefined || n === null || n === '') networks = [...ALL_NETWORKS];
  else {
    const list = Array.isArray(n) ? n.map(String) : typeof n === 'string' ? n.split(',') : undefined;
    if (!list) throw new ChoiceError('networks must be a comma-separated list or an array');
    const seen = new Set<Network>();
    for (const item of list) {
      const s = item.trim().toLowerCase();
      if (!s) continue;
      if (!isNetwork(s)) throw new ChoiceError(`unknown network "${s}"; choose from ${ALL_NETWORKS.join(', ')}`);
      seen.add(s);
    }
    networks = ALL_NETWORKS.filter((x) => seen.has(x));
    if (networks.length === 0) throw new ChoiceError(`choose at least one network from ${ALL_NETWORKS.join(', ')}`);
  }
  let walrusEpochs: number | undefined;
  const e = raw.walrusEpochs;
  if (e !== undefined && e !== null && e !== '') {
    const v = typeof e === 'number' ? e : Number(String(e).trim());
    if (!Number.isInteger(v) || v < 1 || v > MAX_WALRUS_EPOCHS) throw new ChoiceError(`walrus epochs must be a whole number 1..${MAX_WALRUS_EPOCHS} (${EPOCH_DAYS} days each), got ${String(e)}`);
    if (!networks.includes('walrus')) throw new ChoiceError('walrus epochs given but walrus is not among the chosen networks');
    walrusEpochs = v;
  }
  const arns = parseBool(raw.arns, 'arns');
  return { networks, ...(walrusEpochs !== undefined ? { walrusEpochs } : {}), ...(arns ? { arns } : {}) };
}

export type SkipMap = Partial<Record<'arweaveObject' | 'walrus' | 'filecoin' | 'ipfs' | 'page' | 'name', boolean>>;

/** The lib's skip map for these choices: the object stays off every network not chosen; without `arns` the page and the name are skipped; the manifest is untouched. */
export function skipFor(c: Choices): SkipMap {
  const skip: SkipMap = {};
  if (!c.networks.includes('arweave')) skip.arweaveObject = true;
  for (const n of ['walrus', 'filecoin', 'ipfs'] as const) if (!c.networks.includes(n)) skip[n] = true;
  if (!c.arns) {
    skip.page = true;
    skip.name = true;
  }
  return skip;
}

/** True when nothing was chosen away from the defaults. */
export const isDefault = (c: Choices) => c.networks.length === ALL_NETWORKS.length && c.walrusEpochs === undefined && !c.arns;

/** The choices as the door echoes them, and as a shim sends them on. */
export const choicesBlock = (c: Choices) => ({ networks: c.networks, walrusEpochs: c.walrusEpochs ?? null, walrusRetention: `P${(c.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS) * EPOCH_DAYS}D`, arns: !!c.arns });

/** The headers a paid door reads the choices from. Only set when chosen, so a caller sending none stays on the defaults. */
export function choiceHeaders(c: Choices): Record<string, string> {
  const h: Record<string, string> = {};
  if (c.networks.length !== ALL_NETWORKS.length) h['x-networks'] = c.networks.join(',');
  if (c.walrusEpochs !== undefined) h['x-walrus-epochs'] = String(c.walrusEpochs);
  if (c.arns) h['x-arns'] = 'true';
  return h;
}

/** The query string fragment for a free quote door, `&networks=…&walrus-epochs=…&arns=true`, empty on the defaults. */
export function choiceQuery(c: Choices): string {
  let q = '';
  if (c.networks.length !== ALL_NETWORKS.length) q += `&networks=${c.networks.join(',')}`;
  if (c.walrusEpochs !== undefined) q += `&walrus-epochs=${c.walrusEpochs}`;
  if (c.arns) q += '&arns=true';
  return q;
}

/** What `/v1/describe` says a caller may choose. */
export const describeChoices = () => ({
  networks: {
    arweave: { retention: 'permanent', note: 'the object on Arweave through the org store; the signed bill of lading is on Arweave whatever is chosen' },
    walrus: { retention: `P${DEFAULT_WALRUS_EPOCHS * EPOCH_DAYS}D by default`, note: `walrus-epochs 1..${MAX_WALRUS_EPOCHS} (${EPOCH_DAYS} days each) picks the storage period; past ${DEFAULT_WALRUS_EPOCHS} the door adds 1/${DEFAULT_WALRUS_EPOCHS} of the walrus leg per epoch; extend later through renew` },
    filecoin: { retention: 'per-epoch', note: 'paid out of the broker\'s Filecoin Pay deposit for as long as its runway lasts; no per-object duration' },
    ipfs: { retention: 'P365D', note: 'pinned by Pinata for a year plus a copy on the broker\'s own kubo; no per-object duration' },
  },
  arns: {
    default: false,
    note: 'true adds a public bill of lading page and an ArNS name (l-<sha12>_<base>) to the finish, four more legs on the bill; false (the default) returns the signed manifest JSON only, nothing named. A put the door already holds gets its name on a later put with arns true; nothing else is re-bought',
  },
  how: {
    quote: 'GET /v1/quote?size=N&networks=arweave,walrus&walrus-epochs=53&arns=true (same on /v1/quote/parts)',
    put: 'x-networks: arweave,walrus  x-walrus-epochs: 53  x-arns: true  on POST /v1/put and every POST /v1/parts of one object',
    assemble: 'JSON networks: [...], walrusEpochs: n, arns: true on POST /v1/assemble (the same as its parts)',
  },
  minimum: 'at least one network; the price is the legs bought plus the finish (relay copy, manifest; with arns also the page, the path manifest, the name quote and the name)',
});
