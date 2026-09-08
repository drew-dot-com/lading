# Blossom intake (backlog 12)

Any Nostr client that speaks Blossom can use the gate as its media server: the user adds the gate's URL to their kind 10063 server list and every upload from that client becomes a Lading put (four networks, a signed bill of lading on Arweave, an ArNS name). Research date 2026-09-08; sources are the Blossom BUDs at https://github.com/hzrd149/blossom, the NIPs repo, blossom-client-sdk, Amethyst, Damus, route96, blossom-server, nostrcheck and Satellite.

## What the gate exposes

Mounted at the root of the gate host (a Blossom server URL has no path; clients build `${server}/${sha256}` themselves), next to the `/v1/*` x402 doors.

| door | BUD | what it does |
| --- | --- | --- |
| `HEAD /upload` | 06 | pre-flight: `X-SHA-256`, `X-Content-Length`, `X-Content-Type`; 200 when the pubkey's credit covers the put or the bytes are already archived, 402 with an `X-Reason` otherwise |
| `PUT /upload` | 02 | raw body; the sha256 of the bytes is the blob id; a known hash answers 200 from the record, a new one debits the pubkey's credit, runs the put and answers 201 with the descriptor |
| `PUT /mirror` | 04 | `{ "url": "https://…/<sha256>.ext" }`; the gate fetches the bytes, checks the hash, then the same as `/upload` |
| `GET /<sha256>[.ext]`, `HEAD` | 01 | the bytes, proxied from the gate's own IPFS gateway first, then Arweave; `Content-Type` from the manifest. A redirect is allowed only to a URL that carries the same hash, which no Arweave or IPFS gateway URL does, so the gate proxies |
| `DELETE /<sha256>` | 02 | 403: an archive is permanent |
| `GET /list/<pubkey>` | 02 | not implemented (the BUD marks it unrecommended) |
| `GET /v1/credit?pubkey=` | Lading | the pubkey's remaining credit, free |
| `POST /v1/credit` | Lading | x402 door: `x-pubkey` (hex) and `x-usdc` (amount) headers; the paid amount lands as that pubkey's credit |

Every answer carries `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, *` and `Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE`; `OPTIONS` answers 204.

## Auth (BUD-01)

`Authorization: Nostr <base64 event>` of a kind 24242 event, signed by the uploader. Checked: signature, `created_at` in the past, `expiration` tag in the future, a `t` tag equal to the verb (`upload` for `/upload` and `/mirror`), and for uploads an `x` tag equal to the sha256 of the bytes. Reads need no auth.

## Payment

No Blossom BUD defines an x402 flow. BUD-07 (draft) covers Cashu and Lightning through `X-Cashu` and `X-Lightning` headers, which few clients implement (Amethyst does; Damus, Coracle and Primal do not). The only channel to a user on a refusal is the `X-Reason` header, which Amethyst shows verbatim.

So the gate sells credit: anyone with a Base key (the shim, a web page, the operator) pays the x402 door `POST /v1/credit` for a pubkey, and that pubkey's Blossom uploads are priced exactly as `POST /v1/put` (TOON bill with the gate margin, floor 0.05 USDC) and debited from the credit. Empty credit answers 402 with `X-Reason: "<npub> has <balance> USDC credit; this upload costs <price>. Fund it at <gate>/v1/credit"`. A put that fails refunds the debit. There is no free tier: an unpaid upload buys four legs with the operator's floats.

Credit rows live in `<LADING_HOME>/blossom-credit.jsonl` (append only, replayed at boot).

## The descriptor (BUD-02)

```json
{
  "url": "https://lading.167-233-221-236.sslip.io/<sha256>.png",
  "sha256": "<hex>",
  "size": 12345,
  "type": "image/png",
  "uploaded": 1757350000,
  "nip94": [["url", "…"], ["x", "<sha256>"], ["size", "12345"], ["m", "image/png"]],
  "manifest": "https://permagate.io/<manifestTxId>",
  "name": "l-<sha12>_boughtviatoonnode",
  "legs": { "arweave": "<txid>", "walrus": "<blobId>", "filecoin": "<pieceCid>", "ipfs": "<cid>" }
}
```

The extension comes from the upload's `Content-Type` (octet-stream falls back to `bin`).

## NIP-96

Struck through in the NIPs README ("unrecommended: replaced by Blossom"). Damus still uploads only through hard-coded NIP-96 hosts, so a NIP-96 door would not reach Damus users either way. Blossom only.

## Not built yet

- Range requests on `GET /<sha256>` (video scrubbing).
- BUD-07 `X-Lightning` for clients that carry a wallet.
- A `lading_credit` shim tool so a Claude user can fund a friend's npub.
- Unverified: Coracle, Primal and noStrudel behaviour on a 402.
