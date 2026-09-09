# Lading

[![ci](https://github.com/drew-dot-com/lading/actions/workflows/ci.yml/badge.svg)](https://github.com/drew-dot-com/lading/actions/workflows/ci.yml)

Archive broker for agents, on TOON. Every leg answers with a storage
network's own receipt or with a refusal that bought nothing.

A bill of lading is the document a bank pays against. Lading does that for
bytes: an agent opens one payment channel with a TOON node and gets an object
archived on several storage networks, paying per object per network, and
each leg hands back the network's own identifier and proof. Every copy is
then listed in a signed manifest that lives on Arweave under an ArNS name.

Status: v0.11.0, Arweave, Walrus, Filecoin and IPFS legs, ArNS naming, relay copy,
a quote door in front of each broker leg, objects over one packet travelling
as parts, Walrus renewals, network and duration choices at the door, and a hosted x402 gate with an MCP shim so Claude
can archive through it. Runs against Drew's mainnet node today.

## Use it from Claude

Claude's MCP client cannot pay x402 itself, so a small shim runs next to it,
holds a Base key with a little USDC (no ETH needed) and pays the hosted gate
once per tool call. Behind the door every hop is ILP through the TOON edge.

```
claude mcp add lading -e LADING_X402_KEY=0x… -- npx -y lading mcp --gate https://lading.167-233-221-236.sslip.io
```

Tools: `lading_wallet`, `lading_describe`, `lading_quote`, `lading_lookup`
(free), `lading_put` (paid: file path or text, returns every network receipt,
the manifest URL and the ArNS name), `lading_verify` (free), `lading_renew`
(paid). Every paid call asks the gate's free quote first and refuses over
`LADING_MAX_USDC_PER_CALL` (default 0.50 USDC). A 1 MiB put is about 0.15
USDC; a small one about 0.10.

A put is idempotent. `lading_put` hashes the bytes and asks the gate's free
`GET /v1/manifest?sha=` first; bytes the gate already archived come back as the
existing bill of lading with `reused: true` and nothing is paid (`force: true`
archives again at the full price). On the wire the shim declares `x-sha256`,
so a hash the gate already holds is priced at the floor and answered from the
saved record with no leg bought; a paid put that does not declare its hash and
lands on known bytes gets a 409 with the record and is not settled.

The gate (`src/gate.ts`) prices a put on its `content-length`: the TOON bill
for that size from the edge's route prices, times a margin (1.2), never under
a floor (0.05 USDC). Settlement runs only after the put answered 2xx, so a
failed put is not charged to the caller; the gate carries the route prices it
already paid, which is what the margin is for. The manifest a gate put
produces is signed by the gate's key and records `via: {door: 'x402', payer}`.
Doors: `GET /v1/describe`, `GET /v1/quote?size=N[&sha=]`,
`GET /v1/manifest?sha=`, `POST /v1/put`, `GET /v1/renew/quote?id=`,
`POST /v1/renew`, `GET /v1/verify?ref=`, `GET /v1/floats`, `GET /v1/renewals`,
`GET /v1/quote/parts?size=N`, `GET /v1/parts?sha=`, `POST /v1/parts`,
`POST /v1/assemble`. Design notes: `docs/x402-gate.md`.


## Claude Desktop extension

For anyone who does not want a terminal. One file, `lading-<version>.mcpb`,
installs the same shim into Claude Desktop with the key handled for you.

1. Download `lading-<version>.mcpb` from the GitHub releases page.
2. Claude Desktop: Settings, Extensions, Advanced settings, Install Extension
   (or double-click the file). Leave the three settings at their defaults.
3. Ask Claude to run `lading_wallet`. On first run the extension generates a
   Base key at `~/.lading/x402.key` (mode 0600, never shown) and answers with
   its address and USDC balance.
4. Send a few USDC on Base (chain id 8453) to that address. No ETH is needed.
5. Ask Claude to archive a file. Every paid call is quoted first and refused
   above the per-call cap (default 0.50 USDC).

Six tools: `lading_wallet`, `lading_describe`, `lading_quote` (free),
`lading_put` (paid), `lading_verify` (free), `lading_renew` (paid). The
settings are the gate URL, the per-call cap, and an optional private key for
people who would rather pay from a wallet they already hold; the key field can
stay empty.

The bundle is the shim compiled to one file by esbuild (no `node_modules`
inside, about 400 KB); `npm run extension` rebuilds it into `dist/`. The
manifest lives in `extension/manifest.json`. The same first-run key generation
is available to the CLI shim as `lading mcp --gate <url> --autokey`.

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
| 6. IPFS quote | `g.drew.lading.ipfs.quote` (kind 5320, `phase=quote`) | Lading: deliverable, Pinata's price for the size, float | 1,000 |
| 7. IPFS leg | `g.drew.lading.ipfs` (kind 5320) | Lading, on the CID once a gateway served the bytes back | 5,000 flat |
| 8. bill of lading | signed locally by the payer's Nostr key | kind 30320, `d` = sha256 | free |
| 9. relay copy | `g.drew.relay` | the node relay | 1,000 |
| 10. manifest to Arweave | `g.drew.ario` | the org store, on the txId | schedule |
| 11. page + path manifest to Arweave | `g.drew.ario` | the org store, on the two txIds: the rendered bill of lading page, and an `arweave/paths` manifest serving it at `/` and the JSON at `/manifest.json` | schedule, twice |
| 12. name quote | `g.drew.lading.name.quote` (kind 5320, `phase=quote`) | Lading: deliverable, undername, lamports float | 1,000 |
| 13. ArNS name | `g.drew.lading.name` (kind 5320) | Lading, on the ANT record write, pointing at the path manifest | 5,000 |

A leg that fails answers `accept: false`, buys nothing downstream, and costs
the route price. Steps are skippable (`--skip-walrus`, `--skip-filecoin`,
`--skip-ipfs`, `--skip-name`, `--skip-relay`, `--skip-arweave`). A Filecoin or
IPFS quote that says not deliverable skips that leg and carries on; the
manifest then simply lists fewer legs. The local record is written as soon as the
manifest is on Arweave, so a failed name leg is resumable with
`lading name <sha256>` without re-uploading anything.

The name is a page. `https://<name>.permagate.io/` renders the bill of lading
(the object, every leg with its receipt, a button that re-reads each leg and
hashes it in the browser, and one that asks the gate's free verify door), with
nothing loaded from anywhere else; `https://<name>.permagate.io/manifest.json`
is the signed event for programs. Both are on Arweave under the name. A put
from before 0.13 serves the bare JSON at `/`; `lading page <sha256|all>` writes
the page and path manifest for a saved put and points its name at them, and
`verify` reads either shape.

The same bytes put twice from the same home buy nothing the second time:
`put` finds the saved manifest for that sha256 and returns it (`reused`),
buying only a name leg that is still owed; `--force` archives again.

`lading quote <file>` prints the whole bill before paying it (route prices from
the edge plus the four quotes; costs the four quotes). `lading verify <arns-name |
manifest-txid | saved.json>` re-fetches every leg from its network and
compares sha256. `lading describe` prints route prices.

The manifest is a Nostr event, so a relay query for kind 30320 by `#d` finds
every attestation for a given object hash across payers.

## Large objects at the door: parts

The door takes one body of at most 3 MiB and x402 pays one request at a time,
so a larger object goes through as parts. The shim slices it exactly as the
lib does (1 MiB, `parts.ts`), asks `GET /v1/quote/parts?size=N` for the whole
bill (a price per part, the finish, the sum; the cap applies to the sum), then
pays `POST /v1/parts` once per slice (`x-object-sha256`, `x-object-size`,
`x-part-index`, `x-part-count`, `x-part-bytes`, `x-sha256` of the slice) and
`POST /v1/assemble` once for the finish (relay copy, manifest on Arweave, ArNS
name). Each part runs its four legs into the object's progress file on the
gate, the same file a CLI put resumes from; assemble seals the legs, and a
network that holds only some parts makes assemble answer 409 with the missing
indexes (send those again, or `skip` that network). A slice the gate already
bought on Arweave and Walrus is priced at the floor; `GET /v1/parts?sha=` shows
what it holds, free, and the shim skips those. Nothing is held in escrow: every
payment settles on its own answer. One tool call does a bounded amount of it:
a part takes about two minutes and an MCP client times a tool call out (the
SDK default is 60 s), so after `LADING_CALL_BUDGET_S` (45) of parts
`lading_put` returns `inProgress` with what is held and what remains, and the
next call with the same input resumes from the gate's record; the last call
assembles. While a part runs the shim sends MCP progress notifications, which
keep a client that resets its timeout on progress waiting. A 1 MiB part is about 0.12 USDC, the finish
sits on the floor; 50 MB is about 50 payments, 6 USDC and an hour, and needs
the org store's ARIO funded ahead (about 35 ARIO per part). Progress files
never assembled are swept after `LADING_PROGRESS_MAX_AGE_DAYS` (7).

## Choices at the door

A caller picks which networks carry the object and how long Walrus keeps
it; the price follows (0.16). `networks` is any of `arweave`, `walrus`,
`filecoin`, `ipfs`, at least one (default all four); a network left out
drops from the bill together with its quote door, so the price is exactly
the legs bought plus the finish. Leaving `arweave` out keeps only the
object's bytes off it: the signed bill of lading, its page and the ArNS name
are on Arweave whatever is chosen. `walrus-epochs` is the Walrus storage
period in two-week epochs, 1..53 (default 26, a year); set, the write goes
to the native writer, and past 26 the door adds 1/26 of the walrus leg's
route price per epoch (the broker's route is flat for a year; fewer epochs
cost the same, a write's fixed costs being most of it). Nothing else is a
knob: Arweave is permanent, Pinata pins for a year, Filecoin is paid per
epoch from the broker's deposit. The choices ride as `networks=` and
`walrus-epochs=` on `GET /v1/quote` and `GET /v1/quote/parts`, as
`x-networks` and `x-walrus-epochs` headers on `POST /v1/put` and every
`POST /v1/parts` of one object, and as `networks` / `walrusEpochs` in the
`POST /v1/assemble` body; every answer echoes them under `choices` and the
walrus leg's `retention` on the manifest shows the period bought.
`/v1/describe` lists them under `choices`. The shim's `lading_put` and
`lading_quote` take `networks` and `walrusEpochs`; the CLI takes
`--networks a,b` and `--walrus-epochs n` on `put` and `quote`. A hash the
gate already archived is still answered from the saved record whatever is
chosen (choices shape a new archive; `force` archives again).

## Floats and alarms

Every hot key behind a put is judged in one place. The broker answers
`GET /floats` (internal) with a row per key: the Base USDC float that pays
both Lighthouse and Pinata (low under `LADING_WALRUS_LOW_USDC`, default 1), the Filecoin Pay runway
(USDFC, not ok under `LADING_FILECOIN_LOW_RUNWAY_DAYS` days, default 30, or
under `LADING_FILECOIN_LOW_FIL` of gas), and the name key (SOL, low under
`LADING_NAME_LOW_SOL`, default 0.008). The gate adds its own TOON payer (USDC
on Solana, low under one channel deposit; SOL under `LADING_GATE_LOW_SOL`) with
the open channel's headroom, and publishes the whole list as `health` in
`GET /v1/describe` and alone at `GET /v1/floats`, plus a `renewals` row from
its renewal timer; `/health` on both carries
`floats: {ok, low}`. Each row says what to send where. Nothing here alerts:
refuel (the operator's top-up timer) polls `/v1/floats` every half hour, fills
the rows its treasuries can fill, and pushes the rest to the phone.

## Large objects: parts

The connector caps one ILP packet at 2 MiB, and a blob rides inside the
packet base64-encoded, so one job carries about 1.5 MiB of raw object. An
object over that travels as parts (`src/parts.ts`): the client slices it
(1 MiB per part by default, `--part-bytes n` or `LADING_PART_BYTES` to
change; a tail under 127 bytes folds into the previous part), and each part
is its own paid job on each network, at the route's ordinary price. Nothing
reassembles server-side: the store, the Walrus, Filecoin and IPFS doors
each see an ordinary object, and the payer's loss bound stays one part.

The manifest records a chunked leg with `parts`: each part's index, the
network's own id for that slice, and the slice's sha256; the leg's `id` is
part 0's, and the leg tag carries the part count
(`['leg', 'walrus', <id0>, 'P365D', '3']`). `lading verify` fetches every
part, checks each slice's hash, concatenates in index order, and checks the
whole object's sha256.

Each quote door is asked once per leg for the largest part, and the client
then checks the quoted float covers every part still to buy (N times the
downstream price for Walrus and IPFS, N times the add-piece fee for Filecoin) before
paying the first one. Parts already bought are saved under
`~/.lading/progress/<sha256>.json` after every job, so a put that dies
half-way resumes where it stopped instead of paying twice; the file is
removed once the manifest is on Arweave.

A chunked put that has to open a channel locks `LADING_CHANNEL_DEPOSIT`
base units (default 2,000,000, 2 USDC) rather than the client's 100,000
default, since one such put runs to several hundred thousand units.

## Blossom: any Nostr client as a front end

The gate is a [Blossom](https://github.com/hzrd149/blossom) media server at the root of its host (`HEAD`/`PUT /upload`, `PUT /mirror`, `GET /<sha256>.<ext>`). A user adds `https://lading.167-233-221-236.sslip.io` to their kind 10063 server list and every upload from their client (Amethyst, noStrudel, Coracle, Primal) is a Lading put: four networks, a signed bill of lading on Arweave, an ArNS name. The descriptor the client gets back carries the manifest URL and every leg id.

No Nostr client can pay x402, so uploads draw on credit per pubkey: anyone with a Base USDC key pays `POST /v1/credit` (headers `x-pubkey`, `x-usdc`) and that pubkey's uploads are priced exactly like `POST /v1/put` and debited from it. Empty credit answers 402 with an `X-Reason` that names the balance, the price and the fund door, which is the one line a Blossom client shows the user. Design, sources and what is not built yet: [docs/blossom.md](docs/blossom.md).

## What is where

```
src/server.ts    the handler: POST /walrus, /filecoin, /name and their /quote doors, GET /describe, GET /health
src/lib.ts       the client as a library: put, putPart, finish, quote, estimate, verify, name, renewals, renew, describe; the CLI and the gate both run this
src/choices.ts   the two choices a caller makes at a door (networks, Walrus epochs): parsing, the skip map, headers, the describe block; lib-free so the shim bundles it
src/renew-cron.ts the renewal timer's one run: date every record live, renew what is due, report it as a float row and an ntfy push; the gate schedules it, the CLI runs it as renew-due
src/cli.ts       the command line, a thin layer over lib.ts
src/gate.ts      the hosted door: express + x402 (USDC on Base, PayAI facilitator), pays the TOON routes with its own key
src/gate-price.ts what the door charges for a TOON bill: margin and floor, pure
src/mcp.ts       the MCP shim Claude runs locally: pays the gate per tool call with LADING_X402_KEY
src/walrus.ts    Lighthouse x402 upload (USDC on Base), blobId lookup, aggregator read-back
src/walrus-native.ts  native Walrus writer: Sui key, WAL + SUI, Mysten upload relay, aggregator read-back
src/filecoin.ts  Filecoin Onchain Cloud upload (Synapse SDK, USDFC in Filecoin Pay), provider read-back
src/ipfs.ts      Pinata x402 pin (USDC on Base) + our own kubo copy, read-back from our gateway, the pinner's, and one neither runs
src/filecoin-fund.ts  operator tool: deposit USDFC and approve warm storage, once
src/quote.ts     the pure deliverability decisions behind the quote doors
src/arns.ts      ANT undername write, owner or controller
src/manifest.ts  build and verify the kind 30320 bill of lading
src/page.ts      the bill of lading page a name serves, and the arweave/paths manifest behind it
src/floats.ts    float rows: each hot key judged against its low-water mark; GET /floats on the broker, health in the gate's describe
src/cli.ts       the paying client that composes the legs
deploy/routes.toml   the [[routes]] rows for the edge connector
```

Walrus verification, three independent checks recorded in the receipt: the
CID Lighthouse returns is a raw sha256 CID whose digest must equal the file's
sha256 (offline, trusts nobody); the Lighthouse Walrus gateway must serve
bytes with that sha256; and the public Walrus aggregator must serve the blob,
which is a CARv1 archive wrapping the raw block, so the check is containment
of the file bytes. `lading verify` re-runs the gateway check.

Reading back never depends on one AR.IO gateway. A raw txid is content
addressed, so `verify` and the manifest fetch try `LADING_READ_GATEWAYS` in
order (default `permagate.io, arweave.net, ardrive.net`) and the row says which
one answered. An ArNS name may only fall back to gateways that resolve from the
same registry as the primary: `LADING_ARNS_GATEWAYS` (default `ardrive.net,
vilenarios.com`, `programIds` on `/ar-io/info` checked equal 2026-09-08). Diff
`programIds` before adding one; `arweave.net` is not an AR.IO gateway and never
resolves names. Receipts and manifests still print only the primary gateway.

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
change, `GET /walrus/ledger` for the operator's view).

The native Walrus writer (`src/walrus-native.ts`) is the other way to run the
same `/walrus` door: this broker's own Sui key (`LADING_SUI_SECRET_KEY`, a
`suiprivkey…` string) pays WAL for storage and SUI for gas, writes through
Mysten's upload relay (`upload-relay.mainnet.walrus.space`, a SUI tip of 40
MIST per encoded KiB; there is no public mainnet publisher and Mysten says
there will be none), and gets the certified blob object back from the chain.
26 two-week epochs (364 days, `LADING_WALRUS_EPOCHS`) cost about 0.15 WAL per
object whatever its size up to the cap, because Walrus bills on the encoded
size (about 63 MiB of fixed overhead); the quote door reads the live price from
the system object. The receipt records the blob id, the blob OBJECT id (what
an extension needs), start and end epoch, and the aggregator read-back. Blobs
are written permanent (not deletable). `LADING_WALRUS_PROVIDER` picks
`lighthouse`, `native`, or `auto` (the default once the Sui key is set):
native when its WAL and SUI floats cover the write, Lighthouse otherwise, and
the quote names which (`downstream.provider`, `downstream.amount` in that
writer's asset, `alternative` with the other writer's reason). Float rows
`walrus-wal` (low under `LADING_WALRUS_LOW_WAL`, 0.5) and `walrus-sui` (low
under `LADING_WALRUS_LOW_SUI`, 0.05) join `GET /floats`.

A native record is kept alive by extending its blob object on Sui, and only
the object's owner can, which is the broker's Sui key for everything
walrus-native wrote. So the broker sells that too: `g.drew.lading.walrus.extend`
(flat 40,000; `params op=walrus-extend, objectId, epochs` 1..53, default 26)
runs one `extendBlob` transaction paying WAL for storage only (about 0.135
WAL for 26 epochs, no write cost, no relay tip) and answers with the previous
and new end epoch, the instants they map to (from the staking object's epoch
timing: epoch 1 began at `first_epoch_start`, each lasts `epoch_duration`),
and the Sui digest. `g.drew.lading.walrus.extend.quote` (1,000) reads the
object and the timing on chain: found, owned, current and new end epoch,
days left, price, WAL and SUI floats. Walrus refuses a period more than 53
epochs past the current one, so the quote says how many more fit right now.
The chain is the ledger for native records; there is no broker-side file.
`lading renewals` lists native rows by object id with their end epoch and
date (writes since 0.14 carry the date in the receipt; older ones show `?`
until `--live` asks the quote door), and `lading renew <sha256 | object id>
[--epochs n]` extends every native record of a put through the extend doors,
Lighthouse records through the renew doors, quoting each first.

The gate keeps its own records alive on a timer (0.15). Once a day
(`LADING_RENEW_EVERY_HOURS`, 24) it dates every record live and renews each
one that runs out within `LADING_RENEW_WITHIN_DAYS` (30; 0 turns the timer
off): native records get `LADING_RENEW_EPOCHS` more (unset = the door's 26),
Lighthouse ones a year, every purchase quoted first and recorded in the
saved file like a hand renewal. A record bought short by choice at the door
(a Walrus period under the default year, never renewed by hand) is left
alone: the timer keeps year-long records alive, it does not turn 28 days
into a year. One put at a time still holds: a renewal
waits behind any put on the gate's channel. The last run is kept at
`LADING_HOME/renew-cron.json`, served free at `GET /v1/renewals` with every
record's saved date, and judged as the `renewals` float row (balance = days
left on the soonest record, low = the window; not ok when a due record was
not renewed, so refuel raises it like an empty key). With `LADING_NTFY_URL`
set the gate also pushes a note when it bought something (low priority) or
when a human is needed (high). `lading renew-due [--within d] [--epochs n]`
runs the same routine from the CLI for the payer's own records.

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

IPFS is a pin bought from Pinata's x402 door (`402.pinata.cloud`, USDC on
Base, 0.10 USDC per GiB for twelve months, floored at 0.001 USDC), the one
pinning service selling per request with no account as of 2026-09 (Storacha
turned writes off in May 2026; Infura and Fleek closed their IPFS doors;
Filebase and 4EVERLAND want a subscription). The receipt records the CID, the
paid-through instant, and which gateways served the bytes back: Pinata's own
proves the pin, one it does not run (`ipfs.filebase.io`, then `ipfs.io`;
`LADING_IPFS_GATEWAYS`) proves the content is findable on the network, and a
raw sha256 CID is checked offline as well. Pinata sells no renewal; a pin
that runs out is bought again with the same bytes (same CID). `LADING_IPFS=off`
turns the door off.

Lading also runs its own kubo (`lading-kubo` in the compose project, image
pinned, `deploy/kubo-init.sh` for its config): every pinned object is added
there too with Pinata's UnixFS layout, so both name it by the same CID (the
receipt's `proof.kubo` says `pinned` or names the mismatch), the node
reprovides what it pins to the DHT so other gateways can find fresh content,
and `ipfs.<ip>.sslip.io` (Caddy to kubo's gateway, `deploy/Caddyfile.ipfs`)
is a read path of our own that never rate-limits a read-back. It serves only
what it pins (`Gateway.NoFetch`), so it is not a public proxy. Port 4001 (TCP
and UDP) must be open at the host's firewall for other nodes to dial in;
until it is, kubo reaches the network through a relay circuit. A pin on
Pinata is still the durability promise; kubo is a second copy on one box.
`LADING_KUBO_API` (default `http://lading-kubo:5001`) empty skips it.

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
- Arweave, Walrus, Filecoin and IPFS data are public. Encrypt client-side if it matters.
- Filecoin pieces start at 127 bytes; smaller objects skip that leg.
- The Filecoin leg stays stored only while the broker's Filecoin Pay runway lasts; the quote door refuses below the runway floor.
- AR.IO's sub-100 KiB free tier is a trial allowance; price every write as paid.
- No em dashes.
