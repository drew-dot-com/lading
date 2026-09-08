/**
 * Node's fetch gives up waiting for response HEADERS after 300 s (undici's
 * default `headersTimeout`). A Lading job answers only when the leg is done,
 * and a Filecoin commit has taken 313 s on a slow day, so a payer's HTTP call
 * to the edge (and the shim's call to the gate) died at exactly 300 s with
 * "fetch failed" while the far side went on to fulfil. That is how a channel
 * store ends up behind the edge's watermark. Every process that waits on a
 * job installs this once at startup: no header timeout, no body timeout; the
 * packet's own expiry (see FILECOIN_JOB_TIMEOUT_MS) is the deadline.
 */
import { Agent, setGlobalDispatcher } from 'undici';

export function installLongFetch(): void {
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
}
