# Lading

Pay-on-receipt archive broker for agents, on TOON.

A bill of lading is the receipt a bank pays against. Lading does that for
bytes: an agent opens one payment channel with a TOON node and gets an object
archived on several storage networks, paying per object per network, with the
money moving only when the network's receipt comes back. Every copy is then
listed in a signed manifest that lives on Arweave under an ArNS name.

Status: v0.2.0, Arweave and Walrus legs, ArNS naming, relay copy, and a quote
door in front of each broker leg. Filecoin is next. Runs against Drew's
mainnet node today.

## Why this exists

Every storage micropayment product on the market (Lighthouse, Turbo, Pinata
over x402) charges before delivery. Only Filecoin settles on proof, and only
inside Filecoin. Lading sells the receipt: a leg answers with the network's
own identifier and proof, or it answers with a refusal and buys nothing
downstream.

What "pay on receipt" means here, precisely. The TOON connector charges the
route price for every packet it delivers to the app, whatever the app answers
(the execution condition was retired in connector issue 1269, so an app
cannot withhold a FULFILL; a refusal is an answer). So a failed leg costs the
payer the route price and nothing else: the broker never buys storage it
could not deliver, and the payer never holds a receipt for bytes that are not
there. The downstream purchase is the part that is conditional, and it is the
part that costs real money.

To keep the route price from being the cost of finding out, each broker leg
has a quote door at 1,000 units that answers "would this go through right
now": the Walrus quote reads the Lighthouse price for the size and the Base
key's USDC float, the name quote reads the name key's lamports and its ANT
authority. `lading put` asks first and only pays a leg its quote said is
deliverable (`--no-quote` skips the question). A quote-shaped event sent to an
execute door is refused before anything downstream runs.

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
| 2. Walrus quote | `g.drew.lading.walrus.quote` (kind 5320, `phase=quote`) | Lading: deliverable, downstream USDC price, float | 1,000 |
| 3. Walrus leg | `g.drew.lading.walrus` (kind 5320) | Lading, on the Walrus blobId after an aggregator read-back | 40,000 flat |
| 4. bill of lading | signed locally by the payer's Nostr key | kind 30320, `d` = sha256 | free |
| 5. relay copy | `g.drew.relay` | the node relay | 1,000 |
| 6. manifest to Arweave | `g.drew.ario` | the org store, on the txId | schedule |
| 7. name quote | `g.drew.lading.name.quote` (kind 5320, `phase=quote`) | Lading: deliverable, undername, lamports float | 1,000 |
| 8. ArNS name | `g.drew.lading.name` (kind 5320) | Lading, on the ANT record write | 5,000 |

A leg that fails answers `accept: false`, buys nothing downstream, and costs
the route price. Steps are skippable (`--skip-walrus`, `--skip-name`,
`--skip-relay`, `--skip-arweave`). The local record is written as soon as the
manifest is on Arweave, so a failed name leg is resumable with
`lading name <sha256>` without re-uploading anything.

`lading quote <file>` prints the whole bill before paying it (route prices from
the edge plus both quotes; costs the two quotes). `lading verify <arns-name |
manifest-txid | saved.json>` re-fetches every leg from its network and
compares sha256. `lading describe` prints route prices.

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

Walrus verification, three independent checks recorded in the receipt: the
CID Lighthouse returns is a raw sha256 CID whose digest must equal the file's
sha256 (offline, trusts nobody); the Lighthouse Walrus gateway must serve
bytes with that sha256; and the public Walrus aggregator must serve the blob,
which is a CARv1 archive wrapping the raw block, so the check is containment
of the file bytes. `lading verify` re-runs the gateway check.

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
