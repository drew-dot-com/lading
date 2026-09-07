# Lading

[![ci](https://github.com/drew-dot-com/lading/actions/workflows/ci.yml/badge.svg)](https://github.com/drew-dot-com/lading/actions/workflows/ci.yml)

Archive broker for agents, on TOON. Every leg answers with a storage
network's own receipt or with a refusal that bought nothing.

A bill of lading is the document a bank pays against. Lading does that for
bytes: an agent opens one payment channel with a TOON node and gets an object
archived on several storage networks, paying per object per network, and
each leg hands back the network's own identifier and proof. Every copy is
then listed in a signed manifest that lives on Arweave under an ArNS name.

Status: v0.6.0, Arweave, Walrus and Filecoin legs, ArNS naming, relay copy,
a quote door in front of each broker leg, objects over one packet travelling
as parts, Walrus renewals, and a hosted x402 gate with an MCP shim so Claude
can archive through it. Runs against Drew's mainnet node today.

## Use it from Claude

Claude's MCP client cannot pay x402 itself, so a small shim runs next to it,
holds a Base key with a little USDC (no ETH needed) and pays the hosted gate
once per tool call. Behind the door every hop is ILP through the TOON edge.

```
claude mcp add lading -e LADING_X402_KEY=0x… -- npx -y lading mcp --gate https://lading.167-233-221-236.sslip.io
```

Tools: `lading_describe`, `lading_quote` (free), `lading_put` (paid: file
path or text, returns every network receipt, the manifest URL and the ArNS
name), `lading_verify` (free), `lading_renew` (paid). Every paid call asks the
gate's free quote first and refuses over `LADING_MAX_USDC_PER_CALL` (default
0.50 USDC). A 1 MiB put is about 0.15 USDC; a small one about 0.10.

The gate (`src/gate.ts`) prices a put on its `content-length`: the TOON bill
for that size from the edge's route prices, times a margin (1.2), never under
a floor (0.05 USDC). Settlement runs only after the put answered 2xx, so a
failed put is not charged to the caller; the gate carries the route prices it
already paid, which is what the margin is for. The manifest a gate put
produces is signed by the gate's key and records `via: {door: 'x402', payer}`.
Doors: `GET /v1/describe`, `GET /v1/quote?size=N`, `POST /v1/put`,
`GET /v1/renew/quote?id=`, `POST /v1/renew`, `GET /v1/verify?ref=`. Design
notes: `docs/x402-gate.md`.

## Why this exists

Every storage micropayment product on the market (Lighthouse, Turbo, Pinata
over x402) charges before delivery. Only Filecoin settles on proof, and only
inside Filecoin (the Filecoin leg here rides exactly that: Filecoin Onchain
Cloud pays a provider per epoch only while its Proof of Data Possession keeps
landing). Lading sells the receipt across networks: a leg answers with the
network's own identifier and proof, or it answers with a refusal and buys
nothing downstream.

How payment works, precisely. On TOON you pay for an answer: the payment
rides inside the packet and is redeemable the moment the connector delivers
it, whatever the app answers (a refusal is an answer). Lading does not change
that. A failed leg costs the payer the route price and nothing else: the
broker never buys storage it could not deliver, and the payer never holds a
receipt for bytes that are not there. The downstream purchase is the part
that is conditional, and it is the part that costs real money.

To keep the loss bound small, each broker leg
has a quote door at 1,000 units that answers "would this go through right
now": the Walrus quote reads the Lighthouse price for the size and the Base
key's USDC float, the Filecoin quote reads the broker's Filecoin Pay account
(deposit still needed, runway in days), the name quote reads the name key's
lamports and its ANT authority. `lading put` asks first and only pays a leg its quote said is
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
| 4. Filecoin quote | `g.drew.lading.filecoin.quote` (kind 5320, `phase=quote`) | Lading: deliverable, add-piece fee, USDFC float, runway | 1,000 |
| 5. Filecoin leg | `g.drew.lading.filecoin` (kind 5320) | Lading, on the PieceCID once the provider committed it on chain and served it back | 30,000 flat |
| 6. bill of lading | signed locally by the payer's Nostr key | kind 30320, `d` = sha256 | free |
| 7. relay copy | `g.drew.relay` | the node relay | 1,000 |
| 8. manifest to Arweave | `g.drew.ario` | the org store, on the txId | schedule |
| 9. name quote | `g.drew.lading.name.quote` (kind 5320, `phase=quote`) | Lading: deliverable, undername, lamports float | 1,000 |
| 10. ArNS name | `g.drew.lading.name` (kind 5320) | Lading, on the ANT record write | 5,000 |

A leg that fails answers `accept: false`, buys nothing downstream, and costs
the route price. Steps are skippable (`--skip-walrus`, `--skip-filecoin`,
`--skip-name`, `--skip-relay`, `--skip-arweave`). A Filecoin quote that says
not deliverable skips that leg and carries on; the manifest then simply lists
fewer legs. The local record is written as soon as the
manifest is on Arweave, so a failed name leg is resumable with
`lading name <sha256>` without re-uploading anything.

`lading quote <file>` prints the whole bill before paying it (route prices from
the edge plus the three quotes; costs the three quotes). `lading verify <arns-name |
manifest-txid | saved.json>` re-fetches every leg from its network and
compares sha256. `lading describe` prints route prices.

The manifest is a Nostr event, so a relay query for kind 30320 by `#d` finds
every attestation for a given object hash across payers.

## Large objects: parts

The connector caps one ILP packet at 2 MiB, and a blob rides inside the
packet base64-encoded, so one job carries about 1.5 MiB of raw object. An
object over that travels as parts (`src/parts.ts`): the client slices it
(1 MiB per part by default, `--part-bytes n` or `LADING_PART_BYTES` to
change; a tail under 127 bytes folds into the previous part), and each part
is its own paid job on each network, at the route's ordinary price. Nothing
reassembles server-side: the store, the Walrus door and the Filecoin door
each see an ordinary object, and the payer's loss bound stays one part.

The manifest records a chunked leg with `parts`: each part's index, the
network's own id for that slice, and the slice's sha256; the leg's `id` is
part 0's, and the leg tag carries the part count
(`['leg', 'walrus', <id0>, 'P365D', '3']`). `lading verify` fetches every
part, checks each slice's hash, concatenates in index order, and checks the
whole object's sha256.

Each quote door is asked once per leg for the largest part, and the client
then checks the quoted float covers every part still to buy (N times the
downstream price for Walrus, N times the add-piece fee for Filecoin) before
paying the first one. Parts already bought are saved under
`~/.lading/progress/<sha256>.json` after every job, so a put that dies
half-way resumes where it stopped instead of paying twice; the file is
removed once the manifest is on Arweave.

A chunked put that has to open a channel locks `LADING_CHANNEL_DEPOSIT`
base units (default 2,000,000, 2 USDC) rather than the client's 100,000
default, since one such put runs to several hundred thousand units.

## What is where

```
src/server.ts    the handler: POST /walrus, /filecoin, /name and their /quote doors, GET /describe, GET /health
src/lib.ts       the client as a library: put, quote, estimate, verify, name, renewals, renew, describe; the CLI and the gate both run this
src/cli.ts       the command line, a thin layer over lib.ts
src/gate.ts      the hosted door: express + x402 (USDC on Base, PayAI facilitator), pays the TOON routes with its own key
src/gate-price.ts what the door charges for a TOON bill: margin and floor, pure
src/mcp.ts       the MCP shim Claude runs locally: pays the gate per tool call with LADING_X402_KEY
src/walrus.ts    Lighthouse x402 upload (USDC on Base), blobId lookup, aggregator read-back
src/filecoin.ts  Filecoin Onchain Cloud upload (Synapse SDK, USDFC in Filecoin Pay), provider read-back
src/filecoin-fund.ts  operator tool: deposit USDFC and approve warm storage, once
src/quote.ts     the pure deliverability decisions behind the quote doors
src/arns.ts      ANT undername write, owner or controller
src/manifest.ts  build and verify the kind 30320 bill of lading
src/cli.ts       the paying client that composes the legs
deploy/routes.toml   the [[routes]] rows for the edge connector
```

Walrus verification, three independent checks recorded in the receipt: the
CID Lighthouse returns is a raw sha256 CID whose digest must equal the file's
sha256 (offline, trusts nobody); the Lighthouse Walrus gateway must serve
bytes with that sha256; and the public Walrus aggregator must serve the blob,
which is a CARv1 archive wrapping the raw block, so the check is containment
of the file bytes. `lading verify` re-runs the gateway check.

Filecoin verification: the receipt carries the PieceCID, the on-chain data
set and piece ids, the provider id and the provider's `/piece/<PieceCID>`
URL, plus the add-pieces transaction hash when the SDK reports one. The door
reads the bytes back from that URL and compares sha256 before it FULFILLs;
`lading verify` repeats the read. Anyone can check the data set on chain
(Filecoin Warm Storage, chain 314) and its PDP proofs. A receipt records
`complete: no` when the second copy did not land; the primary copy is what
the FULFILL stands on.

The handler holds no payment logic. The connector verifies the claim and
charges the route before a request lands here; the handler reads the
`x-toon-*` headers for its log line only. Coordination across legs lives in
the client, as in every TOON app: a handler is a leaf.

## Pricing notes

Lighthouse bills Walrus on the erasure-coded size, about 63 MiB of overhead per
blob, so a 10-byte upload and a 1 MiB upload both cost about $0.033 downstream
(`/api/upload/price` is exact). With the 2 MiB packet cap every job lands
between $0.032 and $0.036, hence a flat 40,000 base units on the route.
Retention is 365 days and renewal is bound to the paying wallet, which is the
broker's Base key: Lighthouse answers 403 to any other wallet. So the broker
is the one party that can keep a blob alive, and it sells that too. Each
upload's receipt carries the Lighthouse record id and the paid-through instant;
`lading renewals` lists every record in the saved manifests with its date
(`--live` asks Lighthouse for today's, free), and `lading renew <sha256>`
buys one more year per record through `g.drew.lading.walrus.renew` (flat
40,000, same downstream price as the upload), quoting first on
`g.drew.lading.walrus.renew.quote` (1,000: Lighthouse's own renew price, the
current paid-through date, the float). The blob and its id do not change, so
the manifest stands; the renewal is appended to the payer's saved file and to
the broker's ledger (`LADING_DATA_DIR/walrus-ledger.jsonl`, one JSON line per
change, `GET /walrus/ledger` for the operator's view). A native Walrus leg
(own publisher, SUI plus WAL) would return the Sui blob object and certified
epoch directly and is the v2 path.

Filecoin Onchain Cloud is pay-per-epoch out of a USDFC deposit in Filecoin
Pay, with one data set per copy per provider (two copies by default). The
provider takes a one-time fee per add-pieces call (about $0.011 per copy),
and each data set costs $0.12 per month for proving plus $2.50 per TiB per
month for bytes, shared by every object in it. Creating the data sets locks
about 0.62 USDFC each (a refundable lifecycle reserve plus the first month's
proving), so the first upload on a fresh account needs a deposit of about
1.24 USDFC; after that a piece costs cents. Live numbers from the door on
2026-09-06: add-piece fees 0.094 USDFC for two copies, rate 0.24 USDFC per
month, deposit needed 1.24 USDFC on an empty account. 30,000 base units on
the route covers the per-object fee with a margin; the recurring cost is the
broker's to keep paying, which is what the quote's runway floor guards (a
provider may drop a data set whose payer runs dry). Retention in the receipt
is therefore `per-epoch` with the runway in days at the time of the write.

Why not Lighthouse for Filecoin: its hosted x402 endpoint is the Walrus one
(`x402.lighthouse.storage` and `x402-walrus.lighthouse.storage` answer the
same PAYMENT-REQUIRED and the same Walrus gateway URL), and its IPFS plus
Filecoin path is a prepaid API key whose deal shows up hours to a day later.

## Run it

```bash
npm install && npm run build && npm test
```

Handler, on the node (joins the node's existing network, see `docker-compose.yml`):

```bash
cp .env.example .env   # fill LADING_EVM_PRIVATE_KEY (Base, holds USDC), LADING_ANT_ID, LADING_ARNS_BASE_NAME, LADING_SOLANA_KEYPAIR
docker compose up -d --build
```

Filecoin door, once per account. Any secp256k1 key works (the Base key's hex
is fine; the address is the same on Filecoin). Put a little FIL on it for one
transaction and some USDFC (bridge with Squid Router, or mint against FIL at
app.usdfc.net), then:

```bash
LADING_FILECOIN_PRIVATE_KEY=0x... npm run fund:filecoin           # prints balances and the deposit the SDK asks for
LADING_FILECOIN_PRIVATE_KEY=0x... npm run fund:filecoin -- --yes  # sends the one deposit-plus-approval transaction
```

Set `LADING_FILECOIN_PRIVATE_KEY` in `.env` and rebuild; the door is off while
it is unset. `LADING_FILECOIN_COPIES` (2) and `LADING_FILECOIN_MIN_RUNWAY_DAYS`
(7) tune it; `LADING_FILECOIN_CHAIN=calibration` points it at the testnet.

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
- Arweave, Walrus and Filecoin data are public. Encrypt client-side if it matters.
- Filecoin pieces start at 127 bytes; smaller objects skip that leg.
- The Filecoin leg stays stored only while the broker's Filecoin Pay runway lasts; the quote door refuses below the runway floor.
- AR.IO's sub-100 KiB free tier is a trial allowance; price every write as paid.
- No em dashes.
