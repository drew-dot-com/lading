/**
 * Node's fetch gives up waiting for response HEADERS after 300 s (undici's
 * default `headersTimeout`). A Lading job answers only when the leg is done,
 * and a Filecoin commit has taken 313 s on a slow day, so a payer's HTTP call
 * to the edge (and the shim's call to the gate) died at exactly 300 s with
 * "fetch failed" while the far side went on to fulfil. That is how a channel
 * store ends up behind the edge's watermark. Every process that waits on a
 * job installs this once at startup: no header timeout, no body timeout; the
 * packet's own expiry (see FILECOIN_JOB_TIMEOUT_MS) is the deadline.
 *
 * The npm undici Agent this installs is stricter than the one bundled with
 * Node: it refuses a request whose `content-length` is not a single number.
 * Node's fetch always appends the length it computed from the body, so a
 * library that also sets the header by hand (`@solana/kit`'s RPC transport
 * does, `content-length: 133, 133`) fails as "fetch failed / invalid
 * content-length header" the moment this Agent is the dispatcher. Seen
 * 2026-09-08: the gate's Solana float rows read "fetch failed" from the
 * long-fetch deploy on. The Agent therefore carries an interceptor that
 * collapses a repeated length into one and drops a contradictory one so
 * undici computes it. Lading's own code still never sets it by hand.
 */
import { Agent, setGlobalDispatcher, type Dispatcher } from 'undici';

/**
 * One `content-length` value as undici will accept it: a repeated number
 * (`"133, 133"`) becomes `"133"`; anything else that is not a single number
 * is dropped (undefined) so the transport computes it from the body.
 */
export function normalizeContentLength(value: unknown): string | undefined {
  const parts = String(Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  if (!parts.every((p) => /^\d+$/.test(p) && p === parts[0])) return undefined;
  return parts[0];
}

/** Rewrites the request's `content-length` in place, whatever shape undici hands the headers in. */
export const contentLengthInterceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  const headers = opts.headers;
  if (Array.isArray(headers)) {
    for (let i = headers.length - 2; i >= 0; i -= 2) {
      if (String(headers[i]).toLowerCase() !== 'content-length') continue;
      const v = normalizeContentLength(headers[i + 1]);
      if (v === undefined) headers.splice(i, 2);
      else headers[i + 1] = v;
    }
  } else if (headers && typeof headers === 'object') {
    const h = headers as Record<string, unknown>;
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() !== 'content-length') continue;
      const v = normalizeContentLength(h[k]);
      if (v === undefined) delete h[k];
      else h[k] = v;
    }
  }
  return dispatch(opts, handler);
};

export function installLongFetch(): void {
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }).compose(contentLengthInterceptor));
}
