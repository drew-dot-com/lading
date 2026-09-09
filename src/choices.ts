/**
 * What a caller may choose about an archive at the door, and how the price
 * follows. Two choices exist:
 *
 *  - `networks`: which of the four storage networks carry the object. At
 *    least one. The bill of lading itself (the signed manifest, its page and
 *    the ArNS name) is always anchored on Arweave; leaving `arweave` out only
 *    keeps the object's bytes off it. Every network not chosen drops from the
 *    bill with its quote door, so the price is exactly the legs bought.
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
 * quotes, `x-networks` / `x-walrus-epochs` headers on the paid puts and
 * parts, JSON fields on assemble) and on the CLI and shim.
 */
// No lib import: the shim bundles this file and must stay light.
export type Network = 'arweave' | 'walrus' | 'filecoin' | 'ipfs';
const NETWORKS = ['arweave', 'walrus', 'filecoin', 'ipfs'] as const;

/** A choice that cannot be honoured: a 400 at the door, a plain error on the CLI and in the shim. */
export class ChoiceError extends Error {}

export interface Choices {
  networks: Network[];
  walrusEpochs?: number;
}

export const DEFAULT_WALRUS_EPOCHS = 26;
export const MAX_WALRUS_EPOCHS = 53;
export const EPOCH_DAYS = 14;

export const ALL_NETWORKS: Network[] = [...NETWORKS];

/** Every network, no duration set: what a put without choices buys. */
export const defaultChoices = (): Choices => ({ networks: [...ALL_NETWORKS] });

const isNetwork = (s: string): s is Network => (NETWORKS as readonly string[]).includes(s);

/**
 * Validate what a caller sent. `networks` may be a comma list or an array;
 * empty or absent means all four. `walrusEpochs` absent means the broker's
 * default. Anything else is a ChoiceError (a 400 at the door).
 */
export function parseChoices(raw: { networks?: unknown; walrusEpochs?: unknown } = {}): Choices {
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
  return { networks, ...(walrusEpochs !== undefined ? { walrusEpochs } : {}) };
}

/** The lib's skip map for these choices: the object stays off every network not chosen; the manifest, page and name are untouched. */
export function skipFor(c: Choices): Partial<Record<'arweaveObject' | 'walrus' | 'filecoin' | 'ipfs', boolean>> {
  const skip: Partial<Record<'arweaveObject' | 'walrus' | 'filecoin' | 'ipfs', boolean>> = {};
  if (!c.networks.includes('arweave')) skip.arweaveObject = true;
  for (const n of ['walrus', 'filecoin', 'ipfs'] as const) if (!c.networks.includes(n)) skip[n] = true;
  return skip;
}

/** True when nothing was chosen away from the defaults. */
export const isDefault = (c: Choices) => c.networks.length === ALL_NETWORKS.length && c.walrusEpochs === undefined;

/** The choices as the door echoes them, and as a shim sends them on. */
export const choicesBlock = (c: Choices) => ({ networks: c.networks, walrusEpochs: c.walrusEpochs ?? null, walrusRetention: `P${(c.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS) * EPOCH_DAYS}D` });

/** The headers a paid door reads the choices from. Only set when chosen, so a caller sending none stays on the defaults. */
export function choiceHeaders(c: Choices): Record<string, string> {
  const h: Record<string, string> = {};
  if (c.networks.length !== ALL_NETWORKS.length) h['x-networks'] = c.networks.join(',');
  if (c.walrusEpochs !== undefined) h['x-walrus-epochs'] = String(c.walrusEpochs);
  return h;
}

/** The query string fragment for a free quote door, `&networks=…&walrus-epochs=…`, empty on the defaults. */
export function choiceQuery(c: Choices): string {
  let q = '';
  if (c.networks.length !== ALL_NETWORKS.length) q += `&networks=${c.networks.join(',')}`;
  if (c.walrusEpochs !== undefined) q += `&walrus-epochs=${c.walrusEpochs}`;
  return q;
}

/** What `/v1/describe` says a caller may choose. */
export const describeChoices = () => ({
  networks: {
    arweave: { retention: 'permanent', note: 'the object on Arweave through the org store; the bill of lading, its page and the ArNS name are on Arweave whatever is chosen' },
    walrus: { retention: `P${DEFAULT_WALRUS_EPOCHS * EPOCH_DAYS}D by default`, note: `walrus-epochs 1..${MAX_WALRUS_EPOCHS} (${EPOCH_DAYS} days each) picks the storage period; past ${DEFAULT_WALRUS_EPOCHS} the door adds 1/${DEFAULT_WALRUS_EPOCHS} of the walrus leg per epoch; extend later through renew` },
    filecoin: { retention: 'per-epoch', note: 'paid out of the broker\'s Filecoin Pay deposit for as long as its runway lasts; no per-object duration' },
    ipfs: { retention: 'P365D', note: 'pinned by Pinata for a year plus a copy on the broker\'s own kubo; no per-object duration' },
  },
  how: {
    quote: 'GET /v1/quote?size=N&networks=arweave,walrus&walrus-epochs=53 (same on /v1/quote/parts)',
    put: 'x-networks: arweave,walrus  x-walrus-epochs: 53  on POST /v1/put and every POST /v1/parts of one object',
    assemble: 'JSON networks: [...], walrusEpochs: n on POST /v1/assemble (the same as its parts)',
  },
  minimum: 'at least one network; the price is the legs bought plus the finish (relay copy, manifest, name)',
});
