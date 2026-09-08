/**
 * Reading Arweave back through more than one AR.IO gateway.
 *
 * A raw txid is content-addressed: any gateway that answers serves the same
 * bytes, and the caller compares sha256 anyway. So a raw read may fall back to
 * any gateway (`LADING_READ_GATEWAYS`, default `permagate.io, arweave.net,
 * ardrive.net`).
 *
 * An ArNS name is only as good as the registry a gateway resolves it from, so
 * a name may fall back only to gateways whose `/ar-io/info` `programIds`
 * match the primary's (`LADING_ARNS_GATEWAYS`, default `ardrive.net,
 * vilenarios.com`; all three checked equal on 2026-09-08, arns
 * `2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ`). Diff `programIds` before
 * adding one. `arweave.net` is not an AR.IO gateway and never resolves names.
 *
 * The configured ArNS gateway always goes first in both lists, and is the only
 * one ever printed in a receipt or manifest.
 */

export const DEFAULT_READ_GATEWAYS = 'permagate.io,arweave.net,ardrive.net';
export const DEFAULT_ARNS_GATEWAYS = 'ardrive.net,vilenarios.com';

export const ARWEAVE_TXID_RE = /^[A-Za-z0-9_-]{43}$/;

/** A gateway list: the primary first, then the fallbacks, no duplicates, no blanks, no scheme. */
export function readGateways(primary: string, list: string | undefined, defaults = DEFAULT_READ_GATEWAYS): string[] {
  const out: string[] = [];
  for (const g of [primary, ...(list ?? defaults).split(',')]) {
    const h = g.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

export const arweaveReadUrls = (txid: string, gateways: string[]) => gateways.map((g) => `https://${g}/${txid}`);
export const arnsReadUrls = (name: string, gateways: string[]) => gateways.map((g) => `https://${name}.${g}/`);

export interface ReadResult {
  /** HTTP status of the answer used, 0 when the fetch itself threw. */
  status: number;
  bytes?: Uint8Array;
  /** The URL that served the bytes, or the last one tried. */
  url: string;
  /** One line per URL tried, for the verify row. */
  tried: string[];
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Try each URL in order; the first 2xx wins. A thrown fetch counts as status 0 and moves on. */
export async function readFirst(urls: string[], fetchImpl: FetchLike = fetch as FetchLike): Promise<ReadResult> {
  const tried: string[] = [];
  let last = { status: 0, url: urls[0] ?? '' };
  for (const url of urls) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    try {
      const r = await fetchImpl(url);
      if (r.ok) {
        tried.push(`${host} ${r.status}`);
        return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()), url, tried };
      }
      tried.push(`${host} ${r.status}`);
      last = { status: r.status, url };
    } catch (e) {
      tried.push(`${host} ${(e as Error).message.slice(0, 40)}`);
      last = { status: 0, url };
    }
  }
  return { ...last, tried };
}

/** "via arweave.net (permagate.io 503)" when a fallback answered, "" when the first gateway did. */
export function viaNote(r: ReadResult): string {
  if (r.tried.length <= 1) return '';
  const host = r.url.replace(/^https?:\/\//, '').split('/')[0];
  return ` via ${host} (${r.tried.slice(0, -1).join(', ')})`;
}
