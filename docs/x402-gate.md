# The x402 gate: Lading for Claude, hosted (design, 2026-09-07)

Decided with Drew 2026-09-07. **Built 2026-09-07 (0.6.0): `src/lib.ts`,
`src/gate.ts`, `src/gate-price.ts`, `src/mcp.ts`, the `lading-gate` compose
service, `deploy/Caddyfile.lading`.** Checked locally against the live edge:
the free quote for 1 MiB came to 122,070 units (the real 09-07 put was
122,130), the door hands out a v2 402 for 97,344 micro-USDC on `eip155:8453`
with PayAI synced, the shim lists five tools over stdio, its cap refuses a
put over `LADING_MAX_USDC_PER_CALL`, and an unfunded key is refused by the
facilitator before anything runs. Not yet done: deploy on the box (steps at
the bottom), the first paid put through the door, npm publish.
Shape A of three:

> Hosted HTTP door on the node, gated by x402 on Base USDC, plus a thin local
> MCP shim the user runs in Claude Desktop or Claude Code. The shim holds the
> user's Base key and pays the door per tool call. Every hop past the door is
> ILP through the edge, paid by the gate's own TOON payer. x402 is the ingress
> at the boundary with something that does not speak ILP; TOON is the inside.

## Idempotent puts (0.8.0, 2026-09-08)

x402 prices a request before the body is read (the 402 challenge carries the
amount), so the door cannot discover on its own that it already holds the
bytes. The caller declares `x-sha256`; a declared hash with a saved manifest
under the gate's home (`/data/gate/manifests/<sha>.json`, only records whose
manifest reached Arweave) is priced at the floor and answered from the record
through the same `lading.put()`, which returns `reused: true` without opening
a channel or buying a leg (a missing name leg is the one thing it still buys).
A paid put that lands on known bytes without declaring them answers 409 with
the record; the middleware settles only on 2xx, so nothing is charged.
`GET /v1/manifest?sha=` reads the record free, and the shim asks it before
paying anything, so from Claude a repeat put costs nothing. The hash is a
public fact (the manifest is on Arweave and the relay, kind 30320 `d` tag), so
the lookup door leaks nothing new.

## Multipart at the door: design pass (2026-09-08, backlog 6; BUILT as written, 0.9.0)

The question: how does a 50 MB object get through the door from Claude, when the
door takes one body of at most 3 MiB (`MAX_BODY_BYTES`; Caddy caps the request
at 4 MB) and x402 pays one request at a time?

What already exists below the door: `lib.put()` splits an object into 1 MiB
parts (`parts.ts`), buys one job per part per network, records every outcome
in a progress file keyed by the whole object's sha256, and the manifest leg
carries `parts[]`; `verify` reassembles. So the mesh side of "large" is done.
Only the HTTP boundary is missing, and the boundary is where the payment
model has to be chosen.

Two shapes:

**Escrow.** One paid request opens a session priced on the whole object;
unpaid part uploads follow; a commit runs the legs. One payment, one cap check,
simple for the caller. But x402 settles when the session request answers 2xx,
before any leg ran, so the gate holds money for work not yet done. When a leg
fails later there is no refund primitive: the gate would need a hot Base key
that sends USDC back (a new attack surface and a new float), or a credit note
(shape B, deferred). That is the prepaid balance the README says this door
does not have, and it breaks the one property the door is sold on: settlement
only after the put answered. Rejected.

**Per-part charge.** The shim splits the object with the same `planParts`
the lib uses and pays the door once per part, then once for the finish:

- `POST /v1/parts` (x402, priced on the part's size: the three leg routes and
  their quote doors for that many bytes, times the margin, floor applies).
  Headers: `x-object-sha256`, `x-object-size`, `x-part-index`, `x-part-count`,
  `x-sha256` (the part's own hash), `x-file-name`. The gate runs the three legs
  for that slice under the object's progress file (`<home>/progress/<sha>.json`,
  the same file a CLI put resumes from) and answers the per-network part
  receipts. A part whose hash the progress file already holds on every network
  is answered from it at the floor, like an idempotent put.
- `POST /v1/assemble` (x402, priced on the finish: manifest write on the
  Arweave schedule for the manifest's size, relay copy, name quote, name).
  Body: JSON `{sha256, size, partCount, name, mime}`. The gate checks the
  progress file holds every index on every network for that object, builds
  the `parts[]` legs, writes and names the manifest, saves the record, and
  answers the bill of lading. From then on `GET /v1/manifest?sha=` and a plain
  `POST /v1/put` with `x-sha256` see it as archived.

Why this one: every request stays short (one part is about the 96 s the first
paid put took), every payment is small and settles on its own 2xx, a failed
part costs the caller nothing at the door and is retried at the floor once its
legs are in the progress file, and nothing is held. The lib change is small:
`put()` already does this per part inside one call; it needs a `putPart(bytes,
{sha, size, index, count, name, mime})` that runs the legs for one slice into
the progress file, and a `finish(sha, {size, count, name, mime, via})` that
does what the tail of `put()` does from the progress file without the bytes.
The gate's serialisation (one TOON job at a time) means parts land in order
whatever the shim does; the shim uploads them sequentially and shows progress.

Numbers to state plainly: a 1 MiB part is about 103,000 units on the mesh, so
about 0.124 USDC at the door; the finish is on the floor, 0.05. 50 MB is about
50 parts, about 6.2 USDC and roughly an hour. The per-call cap
(`LADING_MAX_USDC_PER_CALL`) must then apply to the whole put, summed over
parts, and the shim quotes the total first. The Arweave leg is the binding
float: the org store spends about 35 ARIO per 1 MiB part
(`STORE_TURBO_MAX_ARIO_PER_UPLOAD` 40), and refuel tops that key up at most
30 ARIO a day, so a 50 MB put needs the store key funded ahead (about 1,750
ARIO), not refilled during. Progress files for objects never assembled should
be swept after a week.

Open for Drew: build the per-part shape as written, or change the part size at
the door (bigger parts, fewer payments, longer requests, the 4 MB Caddy cap and
the ~1.56 MB packet cap both bind). Proving it live costs about 0.6 USDC for a
4 MiB object through the shim key, over the default cap, so the cap is raised
for the proof.

## Why a shim

Claude's own MCP client cannot sign x402 payments. So either a local process
pays (this design), or the user prepays for a bearer token (shape B, deferred:
Claude Desktop remote connectors want OAuth, not a static header, and it
reintroduces a prepaid balance).

Decided 2026-09-08: instead of shape B, the local shim is packaged as a Claude
Desktop extension (`extension/manifest.json`, built by `npm run extension`
into `dist/lading-<version>.mcpb`). The key is generated on first run and
`lading_wallet` shows the address to fund, so a non-developer never touches a
private key, and every call stays a per-call x402 payment from a key the user
holds. Shape B stays deferred. The next step for remote connectors is a
payment link per put: the tool returns a hosted page URL, the user pays it in
a browser wallet, the page reports the tx to the gate, and the put proceeds.

## Facts checked 2026-09-07

- Facilitators settling x402 **v2, `exact`, `eip155:8453` (Base mainnet)**:
  PayAI `https://facilitator.payai.network` (public, no key; `/supported` lists
  `(2, exact, eip155:8453)`). `https://x402.org/facilitator` is Base Sepolia +
  Solana only. `https://facilitator.x402.rs` has no Base mainnet. Coinbase CDP
  supports it but needs a CDP API key (first 1,000 tx/month free). Use PayAI.
- Packages (installed, 2.25.0): `@x402/express` (`paymentMiddleware`,
  `x402ResourceServer`), `@x402/core/server` (`HTTPFacilitatorClient`),
  `@x402/evm/exact/server` (`ExactEvmScheme`). Route config
  `{"POST /v1/put": { accepts: { scheme: 'exact', price, network: 'eip155:8453', payTo }, description }}`;
  `price` may be a function of the request (Lighthouse's server does
  `price: async (ctx) => ...` reading headers via `ctx.adapter.getHeader`).
  Settlement happens **after the handler returns 2xx** (buffered response), so a
  failed put is not charged to the user; the gate eats its TOON route costs,
  bounded by the quote doors.
- Reference implementation: github.com/lighthouse-web3/x402 (`src/routes/*.ts`,
  `src/payments/server.ts`), the same stack Lading already pays as a client.
- MCP: `@modelcontextprotocol/sdk` 1.30.0 (installed), stdio transport for the
  shim. Install line once on npm: `claude mcp add lading -- npx -y lading mcp --gate https://…`.

## Pieces

1. **Library split.** `src/cli.ts` holds put/quote/verify/name/renew inline
   with `process.argv` and `console.log`. Move them into `src/lib.ts` taking an
   options object (edge, routes, keys, channel store, logger) and returning
   data; keep the CLI a thin layer with identical behaviour.
2. **`src/gate.ts`** (express, own entrypoint `dist/gate.js`, port 3601):
   - `GET /v1/describe`, `GET /v1/quote?size=N` free (bill from route prices
     + margin; no paid TOON quotes at quote time).
   - `POST /v1/put` octet-stream body, `x-file-name`, `x-mime`; x402 price per
     request = TOON total for that size (routes + quotes) + margin, in USDC;
     runs the whole put with the gate's payer; returns the bill of lading.
   - `POST /v1/renew` (`lighthouseId`), `GET /v1/verify?ref=` free.
   - Manifest is signed by the gate's Nostr key; add an optional
     `via: { door: 'x402', payer: '0x…' }` to `ManifestContent` so the
     x402 payer is recorded.
   - Env: `LADING_GATE_PAYTO` (Base address for revenue; default the Walrus
     float key so revenue refills the float), `X402_FACILITATOR`
     (PayAI), gate payer `SOLANA_KEYPAIR` + `LADING_CHANNEL_STORE` on a
     volume + `LADING_NOSTR_KEY`, `GATE_FREE=1` dev mode that skips x402.
3. **`src/mcp.ts`**: stdio MCP server, tools `lading_quote`, `lading_put`
   (path or text), `lading_verify`, `lading_renew`, `lading_describe`. Pays
   the gate with `@x402/fetch` + `LADING_X402_KEY` (Base key, USDC only, no
   ETH). Guard: call the free quote first and refuse over
   `LADING_MAX_USDC_PER_CALL` (default 0.50).
4. **Deploy**: second service `lading-gate` in the lading compose project on
   `relay_deploy_net`; Caddy site `lading.167-233-221-236.sslip.io` →
   `lading-gate:3601` (edit `/opt/toon-relay/deploy/Caddyfile` with a backup,
   reload caddy). Nothing else on the host.
5. **Funding (Drew)**: a new Solana key on the box for the gate's TOON payer
   (~5 USDC + 0.05 SOL; the channel opens itself with a 2 USDC deposit), kept
   apart from the Walrus float. For the proof, a Base key with ~1 USDC for the
   shim (or self-pay from the Walrus float key to prove the mechanics).
6. Publish `lading` to npm so the shim is one `npx` line; README gets a
   "Use it from Claude" section at the top.

## Pricing sketch

A 1 MiB put cost 122,130 units (0.1221 USDC) on 2026-09-07 across 9 jobs. Gate
price = quoted TOON total × 1.2, floor $0.05, so a small put is ~$0.06 and a
1 MiB put ~$0.15. Renew ~$0.06.

## Deploy (the box)

1. Generate the gate's payer once: `node -e "const c=require('node:crypto');const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');const d=Buffer.from(privateKey.export({format:'jwk'}).d,'base64url'),x=Buffer.from(publicKey.export({format:'jwk'}).x,'base64url');console.log(JSON.stringify([...Buffer.concat([d,x])]))"` into `/root/keys-2026-09-06/lading-gate-solana.json` (mode 600) and print its address; Drew funds it (~5 USDC + 0.05 SOL).
2. Box `.env` (backup first): `LADING_GATE_SOLANA_KEYPAIR='[…]'`, `LADING_GATE_PAYTO=0x47fbAABeA97ee9cbF196fE0bAddaaF955520d84d` (the Walrus float key, so revenue refills the float), `LADING_GATE_URL=https://lading.167-233-221-236.sslip.io`.
3. rsync the repo (`--exclude .env`, never `--delete`), then
   `docker compose -p lading -f /opt/toon-relay/lading/docker-compose.yml --env-file /opt/toon-relay/lading/.env up -d --build lading-gate`.
4. Caddy: append `deploy/Caddyfile.lading` to `/opt/toon-relay/deploy/Caddyfile` (backup first), then
   `docker exec deploy-caddy-1 caddy reload --config /etc/caddy/Caddyfile` (or `docker compose ... restart caddy`). Caddy fetches the sslip.io certificate on first hit.
5. Check: `curl https://lading.167-233-221-236.sslip.io/health`, `…/v1/quote?size=1048576`, and a `POST /v1/put` without payment returns 402 with the right amount.
6. First paid put: from the Mac, `LADING_X402_KEY=<a Base key with ~1 USDC> npx tsx src/cli.ts mcp --gate https://lading.…` under Claude, or the driver in the scratchpad. Record it in `node-artifacts/lading-first-put-2026-09-06.md`.
