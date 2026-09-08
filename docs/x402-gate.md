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
