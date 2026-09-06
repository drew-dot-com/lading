# Lading

Pay-on-receipt archive broker for agents, on TOON.

A bill of lading is the receipt a bank pays against. Lading does that for
bytes: an agent opens one payment channel with a TOON node and gets an object
archived on several storage networks, paying per object per network, with the
money moving only when the network's receipt comes back. Every copy is then
listed in a signed manifest that lives on Arweave under an ArNS name.

Status: v0.1.0, Arweave and Walrus legs, ArNS naming, relay copy. Filecoin is
next. Runs against Drew's mainnet node today.

## Why this exists

Every storage micropayment product on the market (Lighthouse, Turbo, Pinata
over x402) charges before delivery. Only Filecoin settles on proof, and only
inside Filecoin. An ILP packet fulfils on a receipt or the money never moves,
so a TOON node can sell pay-on-receipt across networks without a new primitive.

The buyer's pain Lading removes is one prepaid balance per provider: Turbo
Credits, a Lighthouse deposit, WAL plus SUI, a Storj minimum. One channel
deposit, then off-chain claims per job.

## How a `put` runs

```
lading put report.pdf
```

| step | route | who fulfils, on what | price |
| --- | --- | --- | --- |
| 1. Arweave leg | `g.drew.ario` (kind 5094) | the org store, on the Arweave txId | `{base 1000, per_kib 30}` |
| 2. Walrus leg | `g.drew.lading.walrus` (kind 5320) | Lading, on the Walrus blobId after an aggregator read-back | 40,000 flat |
| 3. bill of lading | signed locally by the payer's Nostr key | kind 30320, `d` = sha256 | free |
| 4. relay copy | `g.drew.relay` | the node relay | 1,000 |
| 5. manifest to Arweave | `g.drew.ario` | the org store, on the txId | schedule |
| 6. ArNS name | `g.drew.lading.name` (kind 5320) | Lading, on the ANT record write | 5,000 |

A leg that fails is rejected before FULFILL, so it is not charged. Steps are
skippable (`--skip-walrus`, `--skip-name`, `--skip-relay`, `--skip-arweave`).

`lading verify <arns-name | manifest-txid | saved.json>` re-fetches every leg
from its network and compares sha256. `lading describe` prints route prices.

The manifest is a Nostr event, so a relay query for kind 30320 by `#d` finds
every attestation for a given object hash across payers.

## What is where

```
src/server.ts    the handler: POST /walrus, POST /name, GET /describe, GET /health
src/walrus.ts    Lighthouse x402 upload (USDC on Base), blobId lookup, aggregator read-back
src/arns.ts      ANT undername write, owner-only
src/manifest.ts  build and verify the kind 30320 bill of lading
src/cli.ts       the paying client that composes the legs
deploy/routes.toml   the two [[routes]] rows for the edge connector
```

The handler holds no payment logic. The connector verifies the claim and
charges the route before a request lands here; the handler reads the
`x-toon-*` headers for its log line only. Coordination across legs lives in
the client, as in every TOON app: a handler is a leaf.

## Pricing notes

Lighthouse bills Walrus on the erasure-coded size, about 63 MiB of overhead per
blob, so a 10-byte upload and a 1 MiB upload both cost about $0.033 downstream
(`/api/upload/price` is exact). With the 2 MiB packet cap every job lands
between $0.032 and $0.036, hence a flat 40,000 base units on the route.
Retention is 365 days; renewal is bound to the paying wallet, which is the
broker's Base key. A native Walrus leg (own publisher, SUI plus WAL) would
return the Sui blob object and certified epoch directly and is the v2 path.

## Run it

```bash
npm install && npm run build && npm test
```

Handler, on the node (joins the node's existing network, see `docker-compose.yml`):

```bash
cp .env.example .env   # fill LADING_EVM_PRIVATE_KEY (Base, holds USDC), LADING_ANT_ID, LADING_ARNS_BASE_NAME, LADING_SOLANA_KEYPAIR
docker compose up -d --build
```

Then append `deploy/routes.toml` to the edge connector config and restart it.

Client, anywhere:

```bash
SOLANA_KEYPAIR=~/.config/solana/id.json npx tsx src/cli.ts put ./file.bin
```

Env: `TOON_EDGE`, `LADING_ROUTE_*`, `LADING_CHANNEL_STORE` (the claim
watermark, keep it), `LADING_NOSTR_KEY` (payer identity, else generated into
`~/.lading/nostr.key`).

## Constraints

- Objects stay under the 2 MiB packet cap; chunking is a later feature.
- Arweave and Walrus data are public. Encrypt client-side if it matters.
- AR.IO's sub-100 KiB free tier is a trial allowance; price every write as paid.
- No em dashes.
