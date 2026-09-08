/**
 * The MCP shim: Lading for Claude, over stdio.
 *
 * Claude's own MCP client cannot sign an x402 payment, so this small process
 * runs on the user's machine, holds their Base key (LADING_X402_KEY, USDC only,
 * no ETH needed) and pays the hosted gate (gate.ts) once per paid tool call.
 * It never talks to a TOON connector; that is the gate's side of the door.
 *
 *   claude mcp add lading -e LADING_X402_KEY=0x… -- npx -y lading mcp --gate https://…
 *
 * Guard: every paid call asks the gate's free quote first and refuses over
 * LADING_MAX_USDC_PER_CALL (default 0.50); the x402 client enforces the same
 * cap on the wire. Without a key the free tools still work.
 *
 * stdout belongs to the MCP transport; every log line here goes to stderr.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { usdcToMicro } from './gate-price.js';
import { VERSION } from './version.js';
import { installLongFetch } from './long-fetch.js';

/** The bundle bakes its version in at build time (no package.json beside it); the CLI reads package.json. */
export const MCP_VERSION = process.env.LADING_BUNDLED_VERSION ?? VERSION;
/** USDC on Base mainnet, 6 decimals. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

export interface McpOptions {
  /** The gate's public URL. */
  gate: string;
  /** Hex Base private key that pays the door. Optional: without it only the free tools answer, unless `keyFile` is set. */
  key?: string;
  /** Where the payer key lives when `key` is not given. With `autoKey`, a fresh key is generated there (0600) on first run. */
  keyFile?: string;
  autoKey?: boolean;
  /** USDC cap per paid call, decimal string. */
  maxUsdc: string;
  /** Seconds of parts one multipart tool call sends before handing back progress (an MCP client times a tool call out; the next call resumes). */
  callBudgetS?: number;
  /** Base RPC for balance reads (free tool), default mainnet.base.org. */
  baseRpc?: string;
}

/** The shim's key: explicit hex first, then the key file, generating one when asked. Returns undefined when none. */
export function resolveKey(o: Pick<McpOptions, 'key' | 'keyFile' | 'autoKey'>, log: (...a: unknown[]) => void): { key?: `0x${string}`; from: string } {
  const given = o.key?.trim();
  if (given) {
    if (/^0x[0-9a-fA-F]{64}$/.test(given)) return { key: given as `0x${string}`, from: 'env' };
    // Claude Desktop hands an extension the literal `${user_config.key}` when the optional field was left empty
    // (seen 2026-09-08: the server died on "invalid private key" before answering initialize). Anything that is
    // not a key is treated as no key, said once, and the key file takes over.
    log(`LADING_X402_KEY ignored: ${/^\$\{.*\}$/.test(given) ? 'the extension field was left empty' : 'not a 0x 32-byte hex key'}; using the key file`);
  }
  if (!o.keyFile) return { from: 'none' };
  if (existsSync(o.keyFile)) {
    const k = readFileSync(o.keyFile, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${o.keyFile} is not a 32-byte hex key`);
    return { key: k as `0x${string}`, from: o.keyFile };
  }
  if (!o.autoKey) return { from: 'none' };
  const k = generatePrivateKey();
  mkdirSync(dirname(o.keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(o.keyFile, `${k}\n`, { mode: 0o600 });
  log(`generated a new payer key at ${o.keyFile} (address ${privateKeyToAccount(k).address}); fund it with USDC on Base`);
  return { key: k, from: `${o.keyFile} (new)` };
}

export const defaultKeyFile = () => join(process.env.LADING_HOME ?? join(homedir(), '.lading'), 'x402.key');

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

/** A non-2xx answer from the gate, with its JSON body (a 409 from /v1/assemble carries `missing`). */
export class GateError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`gate ${status}: ${String(body.error ?? JSON.stringify(body))}`);
  }
}

export async function runMcp(o: McpOptions) {
  installLongFetch();
  const gate = o.gate.replace(/\/+$/, '');
  const maxMicro = usdcToMicro(o.maxUsdc);
  const log = (...a: unknown[]) => console.error('lading mcp:', ...a);

  let payFetch: typeof fetch | undefined;
  let payer: string | undefined;
  const resolved = resolveKey(o, log);
  if (resolved.key) {
    const signer = privateKeyToAccount(resolved.key);
    payer = signer.address;
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    client.setSpendControls({ maxAmountPerPayment: o.maxUsdc });
    payFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  }

  const chain = createPublicClient({ chain: base, transport: http(o.baseRpc ?? 'https://mainnet.base.org') });
  /** The payer's USDC on Base, read from chain. Free. */
  async function balance(): Promise<{ address: string; usdc: string } | undefined> {
    if (!payer) return undefined;
    const raw = await chain.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [payer as `0x${string}`] });
    return { address: payer, usdc: formatUnits(raw, 6) };
  }
  const fundingNote = (address: string) =>
    `Send USDC on Base (chain id 8453, USDC contract ${BASE_USDC}) to ${address}. No ETH is needed: x402 payments use EIP-3009 and the facilitator pays gas. Do not send USDC on any other chain.`;

  async function getJson(path: string): Promise<unknown> {
    const r = await fetch(`${gate}${path}`);
    const body = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`gate ${r.status}: ${String(body.error ?? JSON.stringify(body))}`);
    return body;
  }

  /** What the door takes in one body and how it slices larger objects, read once from describe. */
  let doorFacts: Promise<{ maxBodyBytes: number; partBytes: number }> | undefined;
  const door = () =>
    (doorFacts ??= getJson('/v1/describe').then((d) => {
      const x = d as { door?: { maxBodyBytes?: number }; partBytes?: number };
      return { maxBodyBytes: Number(x.door?.maxBodyBytes ?? 3 * 1024 * 1024), partBytes: Number(x.partBytes ?? 1024 * 1024) };
    }));

  /** Where the parts of an object fall: the same plan the gate recomputes (parts.ts), so the slices agree. */
  function plan(size: number, partBytes: number): Array<{ index: number; offset: number; size: number }> {
    const MIN_TAIL = 127;
    const out = [];
    let offset = 0;
    while (offset < size) {
      const remaining = size - offset;
      const take = remaining > partBytes && remaining - partBytes < MIN_TAIL ? remaining : Math.min(partBytes, remaining);
      out.push({ index: out.length, offset, size: take });
      offset += take;
    }
    return out;
  }

  /**
   * A large object through the door as parts: quote the whole bill first
   * (the cap applies to the sum), skip slices the gate already holds, pay one
   * POST /v1/parts per slice, then one POST /v1/assemble. Every request is
   * short and every payment settles on its own answer; a slice that fails is
   * simply sent again (at the floor once its legs are in).
   *
   * One tool call does a bounded amount of it: an MCP client times a tool call
   * out (the SDK's default is 60 s; a part takes about that), so after
   * `callBudgetS` of parts the call returns progress and the next call with
   * the same input resumes from the gate's own record of what it holds.
   */
  /** MCP progress for a client that asked for it (a progressToken in the call's _meta): one tick per part, and a heartbeat while a part runs, so a client that resets its timeout on progress keeps the call alive. */
  type Extra = { _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };
  function progressOf(extra: Extra | undefined) {
    const token = extra?._meta?.progressToken;
    const send = extra?.sendNotification;
    if (token === undefined || !send) return { tick: async (_p: number, _t: number, _m: string) => undefined, heartbeat: (_m: () => string) => () => undefined };
    return {
      tick: (progress: number, total: number, message: string) => send({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } }).catch(() => undefined),
      heartbeat: (message: () => string) => {
        let n = 0;
        const h = setInterval(() => void send({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: message() } }).catch(() => undefined), 15_000);
        return () => clearInterval(h);
      },
    };
  }

  async function multipartPut(bytes: Uint8Array<ArrayBuffer>, sha: string, fileName: string, contentType: string, partBytes: number, extra?: Extra): Promise<unknown> {
    const prog = progressOf(extra);
    const q = (await getJson(`/v1/quote/parts?size=${bytes.length}&part-bytes=${partBytes}&sha=${sha}`)) as {
      parts: number;
      plan: Array<{ index: number; size: number; reused: boolean; price: string }>;
      finish: { price: string; reused: boolean };
      total: { usdc: string; payments: number };
      status?: { archived: boolean; networks: Record<string, { indexes: number[]; sealed: boolean }> };
    };
    if (usdcToMicro(q.total.usdc) > maxMicro) throw new Error(`archiving ${bytes.length} bytes as ${q.parts} parts would cost ${q.total.usdc} USDC in ${q.total.payments} payments, over the ${o.maxUsdc} USDC cap (LADING_MAX_USDC_PER_CALL)`);
    if (q.status?.archived) return archived(sha);
    const slices = plan(bytes.length, partBytes);
    if (slices.length !== q.parts) throw new Error(`the door plans ${q.parts} parts, this shim ${slices.length}; part size disagreement`);
    log(`put ${fileName} ${bytes.length} B as ${q.parts} parts of ${partBytes} B: ${q.total.usdc} USDC over ${q.total.payments} payments`);
    const budgetMs = (o.callBudgetS ?? 45) * 1000;
    const started = Date.now();
    const sent: number[] = [];
    const skipped: number[] = [];
    const remaining: number[] = [];
    for (const p of slices) {
      const held = (['arweave', 'walrus'] as const).every((n) => q.status?.networks[n]?.sealed || q.status?.networks[n]?.indexes.includes(p.index));
      if (held) {
        skipped.push(p.index);
        continue;
      }
      if (sent.length > 0 && Date.now() - started > budgetMs) {
        remaining.push(p.index);
        continue;
      }
      const slice = bytes.subarray(p.offset, p.offset + p.size);
      const partSha = sha256Hex(slice);
      const t0 = Date.now();
      await prog.tick(skipped.length + sent.length, slices.length + 1, `part ${p.index + 1}/${slices.length}: sending ${slice.length} bytes`);
      const stopBeat = prog.heartbeat(() => `part ${p.index + 1}/${slices.length}: legs running, ${Math.round((Date.now() - t0) / 1000)} s`);
      const r = (await paid('/v1/parts', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-object-sha256': sha,
          'x-object-size': String(bytes.length),
          'x-part-index': String(p.index),
          'x-part-count': String(slices.length),
          'x-part-bytes': String(partBytes),
          'x-sha256': partSha,
          'x-file-name': encodeURIComponent(fileName),
          'x-mime': contentType,
        },
        body: slice,
      }).finally(stopBeat)) as { receipts?: Record<string, unknown>; missing?: string[]; toon?: { usdc?: string }; x402?: { transaction?: string } };
      sent.push(p.index);
      log(`part ${p.index + 1}/${slices.length} ${slice.length} B: ${Object.keys(r.receipts ?? {}).join('+') || 'nothing'}${r.missing?.length ? ` (missing ${r.missing.join(',')})` : ''} ${Date.now() - t0} ms`);
    }
    if (remaining.length) {
      const done = skipped.length + sent.length;
      log(`put ${fileName}: ${done}/${slices.length} parts held by the gate after this call; ${remaining.length} to go`);
      return {
        inProgress: true,
        sha256: sha,
        size: bytes.length,
        parts: slices.length,
        partsHeld: done,
        sentThisCall: sent,
        alreadyHeld: skipped,
        remaining,
        quotedTotalUsdc: q.total.usdc,
        next: `Call lading_put again with the same input to continue: the gate keeps every part it bought, those are skipped free, and the last call assembles the bill of lading. ${remaining.length} part(s) and the finish remain.`,
      };
    }
    const sendSlice = async (index: number) => {
      const p = slices[index]!;
      const slice = bytes.subarray(p.offset, p.offset + p.size);
      return (await paid('/v1/parts', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-object-sha256': sha,
          'x-object-size': String(bytes.length),
          'x-part-index': String(p.index),
          'x-part-count': String(slices.length),
          'x-part-bytes': String(partBytes),
          'x-sha256': sha256Hex(slice),
          'x-file-name': encodeURIComponent(fileName),
          'x-mime': contentType,
        },
        body: slice,
      })) as { receipts?: Record<string, unknown>; missing?: string[] };
    };
    const assemble = async (skip: string[]) => {
      await prog.tick(slices.length, slices.length + 1, 'assembling: manifest, relay copy, ArNS name');
      const stopBeat = prog.heartbeat(() => 'assembling');
      try {
        return await paid('/v1/assemble', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-object-sha256': sha, 'x-part-count': String(slices.length) },
          body: JSON.stringify({ sha256: sha, size: bytes.length, partCount: slices.length, partBytes, name: fileName, mime: contentType, ...(skip.length ? { skip } : {}) }),
        });
      } finally {
        stopBeat();
      }
    };
    // A network may hold only some parts (a leg that failed on one slice, or a
    // leg added after the first slices were bought). Assemble then answers 409
    // with the gaps; those slices go once more at the floor (Arweave and Walrus
    // hold them, so the gate buys only what is missing), and a network still
    // short after that is left off the manifest rather than blocking it.
    const refilled: number[] = [];
    let dropped: string[] = [];
    let a: unknown;
    try {
      a = await assemble([]);
    } catch (e) {
      const gaps = gapsOf(e);
      if (!gaps) throw e;
      const indexes = [...new Set(Object.values(gaps).flat())].sort((x, y) => x - y);
      log(`assemble: parts missing on ${Object.entries(gaps).map(([n, v]) => `${n} ${v.join(',')}`).join('; ')}; sending ${indexes.length} slice(s) again to fill them`);
      for (const index of indexes) {
        const t0 = Date.now();
        await prog.tick(slices.length, slices.length + 1, `refill part ${index + 1}/${slices.length}: sending ${slices[index]!.size} bytes for ${Object.entries(gaps).filter(([, v]) => v.includes(index)).map(([n]) => n).join('+')}`);
        const stopBeat = prog.heartbeat(() => `refill part ${index + 1}/${slices.length}: legs running, ${Math.round((Date.now() - t0) / 1000)} s`);
        try {
          const r = await sendSlice(index).finally(stopBeat);
          refilled.push(index);
          log(`refill part ${index + 1}/${slices.length}: ${Object.keys(r.receipts ?? {}).join('+') || 'nothing'}${r.missing?.length ? ` (still missing ${r.missing.join(',')})` : ''} ${Date.now() - t0} ms`);
        } catch (e) {
          // A leg that fails on the refill too (nothing charged for it) leaves the gap; the second assemble decides whether that network is dropped.
          log(`refill part ${index + 1}/${slices.length} failed, ${Date.now() - t0} ms: ${(e as Error).message.slice(0, 200)}`);
        }
      }
      try {
        a = await assemble([]);
      } catch (e2) {
        const again = gapsOf(e2);
        if (!again) throw e2;
        dropped = Object.keys(again).filter((n) => n !== 'arweave' && n !== 'walrus');
        if (dropped.length !== Object.keys(again).length) throw e2;
        log(`assemble: ${dropped.join(', ')} still short after the refill; finishing without ${dropped.length === 1 ? 'it' : 'them'}`);
        a = await assemble(dropped);
      }
    }
    await prog.tick(slices.length + 1, slices.length + 1, 'done');
    return { ...(a as object), multipart: { parts: slices.length, partBytes, sent, skipped, refilled, ...(dropped.length ? { droppedNetworks: dropped } : {}), quotedTotalUsdc: q.total.usdc } };
  }

  /** The gaps a 409 from /v1/assemble names, or undefined for any other error. */
  function gapsOf(e: unknown): Record<string, number[]> | undefined {
    const m = e instanceof GateError ? e.body : undefined;
    const missing = (m as { missing?: unknown } | undefined)?.missing;
    if (!missing || typeof missing !== 'object') return undefined;
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(missing as Record<string, unknown>)) if (Array.isArray(v) && v.length) out[k] = v.map(Number);
    return Object.keys(out).length ? out : undefined;
  }

  /** The bill of lading the gate already holds for these bytes, or undefined. Free. */
  async function archived(sha: string): Promise<Record<string, unknown> | undefined> {
    const r = await fetch(`${gate}/v1/manifest?sha=${sha}`);
    if (r.status === 404) return undefined;
    const body = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`gate ${r.status}: ${String(body.error ?? JSON.stringify(body))}`);
    return body;
  }

  /** The bytes a tool was handed: a file, or a text string. */
  function inputBytes(path: string | undefined, body: string | undefined): Uint8Array<ArrayBuffer> {
    if (!path && body === undefined) throw new Error('give path or text');
    const bytes = path ? new Uint8Array(readFileSync(resolve(path))) : new TextEncoder().encode(body!);
    if (bytes.length === 0) throw new Error('nothing to archive: empty input');
    return bytes;
  }

  /** The gate's free quote, checked against the cap, before any paid call. */
  async function guard(quotePath: string, what: string): Promise<{ usdc: string }> {
    const q = (await getJson(quotePath)) as { price?: { usdc?: string } };
    const usdc = q.price?.usdc;
    if (!usdc) throw new Error('gate quote carried no price');
    if (usdcToMicro(usdc) > maxMicro) throw new Error(`${what} would cost ${usdc} USDC, over the ${o.maxUsdc} USDC cap (LADING_MAX_USDC_PER_CALL)`);
    return { usdc };
  }

  async function paid(path: string, init: RequestInit): Promise<unknown> {
    if (!payFetch) throw new Error('no LADING_X402_KEY: this shim can only call the free tools (wallet, describe, quote, lookup, verify)');
    const r = await payFetch(`${gate}${path}`, init);
    const body = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (r.status === 402) {
      // The door refused the payment itself: the reason rides in the PAYMENT-REQUIRED header, not the body.
      const pr = decodeReceipt(r.headers.get('payment-required') ?? '') as { error?: string; accepts?: Array<{ amount?: string }> } | string;
      const why = typeof pr === 'object' && pr?.error ? pr.error : 'payment refused';
      const amount = typeof pr === 'object' && pr?.accepts?.[0]?.amount ? ` (asked ${Number(pr.accepts[0].amount) / 1e6} USDC on Base from ${payer})` : '';
      throw new Error(`payment not accepted: ${why}${amount}. ${payer ? fundingNote(payer) : 'The payer needs USDC on Base; no ETH is needed.'}`);
    }
    if (!r.ok) throw new GateError(r.status, body);
    const receipt = r.headers.get('payment-response') ?? r.headers.get('x-payment-response');
    return receipt ? { ...body, x402: decodeReceipt(receipt) } : body;
  }

  const server = new McpServer({ name: 'lading', version: MCP_VERSION });

  server.registerTool(
    'lading_wallet',
    {
      title: 'Lading payer wallet',
      description: 'Free. The address this shim pays the door from, its USDC balance on Base, where the key is kept, and how to fund it. Call this when a paid tool is refused for balance.',
      inputSchema: {},
    },
    async () => {
      try {
        if (!payer) return text({ payer: null, keyFrom: resolved.from, note: 'No payer key. Set LADING_X402_KEY, or point LADING_X402_KEY_FILE at a hex key (the extension generates one on first run).' });
        const b = (await balance().catch((e: Error) => ({ address: payer!, usdc: `unavailable (${e.message.slice(0, 60)})` }))) ?? { address: payer, usdc: 'unavailable' };
        return text({ payer: b.address, usdcOnBase: b.usdc, keyFrom: resolved.from, maxUsdcPerCall: o.maxUsdc, network: 'eip155:8453', usdcContract: BASE_USDC, fund: fundingNote(b.address) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_describe',
    {
      title: 'Describe the Lading gate',
      description: 'What the hosted Lading gate sells (Arweave + Walrus + Filecoin + IPFS archive with a signed bill of lading named on ArNS), its prices, the x402 network and payTo, and this shim\'s payer and cap.',
      inputSchema: {},
    },
    async () => {
      try {
        const d = await getJson('/v1/describe');
        const b = await balance().catch(() => undefined);
        return text({ ...(d as object), shim: { payer: payer ?? null, usdcOnBase: b?.usdc ?? null, keyFrom: resolved.from, maxUsdcPerCall: o.maxUsdc, paidToolsEnabled: !!payFetch } });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_quote',
    {
      title: 'Quote a Lading put',
      description: 'Free. The USDC price this door charges to archive an object of the given size (or the file at path), with the underlying TOON bill per leg. With a path the file is hashed too, so a file the gate already archived quotes at the floor with reused: true.',
      inputSchema: { size: z.number().int().positive().optional().describe('object size in bytes'), path: z.string().optional().describe('local file to size and hash instead') },
    },
    async ({ size, path }) => {
      try {
        const n = path ? statSync(resolve(path)).size : size;
        if (!n) return fail('give size or path');
        const sha = path ? `&sha=${sha256Hex(new Uint8Array(readFileSync(resolve(path))))}` : '';
        const facts = await door();
        if (n > facts.maxBodyBytes) return text(await getJson(`/v1/quote/parts?size=${n}&part-bytes=${facts.partBytes}${sha}`));
        return text(await getJson(`/v1/quote?size=${n}${sha}`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_lookup',
    {
      title: 'Is this already archived?',
      description: 'Free. Whether the gate already holds a bill of lading for a file (path), a text string, or a sha256. Returns the existing record (receipts, manifest URL, ArNS name) or says it is not archived. lading_put runs this first and pays nothing for bytes the gate already archived.',
      inputSchema: {
        path: z.string().optional().describe('local file to hash'),
        text: z.string().optional().describe('text to hash instead of a file'),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe('the object hash directly'),
      },
    },
    async ({ path, text: body, sha256: sha }) => {
      try {
        const hash = sha ? sha.toLowerCase() : sha256Hex(inputBytes(path, body));
        const hit = await archived(hash);
        if (hit) return text({ archived: true, ...hit });
        const status = (await getJson(`/v1/parts?sha=${hash}`)) as { networks?: Record<string, unknown> };
        const inProgress = Object.keys(status.networks ?? {}).length > 0;
        return text({ archived: false, sha256: hash, ...(inProgress ? { partsInProgress: status, note: 'parts of this object are already bought; lading_put resumes and finishes it' } : { note: 'not archived by this gate; lading_put would archive it' }) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_put',
    {
      title: 'Archive with Lading',
      description:
        'PAID (USDC on Base, quoted first, refused over the cap). Archives a local file (path) or a text string onto Arweave, Walrus, Filecoin and IPFS through the TOON mesh, writes a signed bill of lading to Arweave and names it on ArNS. Returns every network receipt, the manifest URL and the ArNS name. Idempotent: bytes the gate already archived come back from the existing record and nothing is paid, unless force is true. Objects over the door\'s single-body limit (3 MiB) go as 1 MiB parts, one small payment each plus one for the finish; the cap applies to the whole bill, and a put that dies resumes where it stopped.',
      inputSchema: {
        path: z.string().optional().describe('local file to archive'),
        text: z.string().optional().describe('text to archive instead of a file'),
        name: z.string().optional().describe('file name to record (default: basename of path, or text.txt)'),
        mime: z.string().optional().describe('content type (default from the name, or text/plain for text)'),
        force: z.boolean().optional().describe('archive again even if the gate already holds these bytes (pays the full price)'),
      },
    },
    async ({ path, text: body, name, mime, force }, extra) => {
      try {
        const bytes = inputBytes(path, body);
        const sha = sha256Hex(bytes);
        const fileName = name ?? (path ? basename(path) : 'text.txt');
        const contentType = mime ?? (path ? 'application/octet-stream' : 'text/plain; charset=utf-8');
        if (!force) {
          const hit = await archived(sha);
          if (hit) {
            log(`put ${fileName} ${bytes.length} B already archived as ${String(hit.manifestTxId)}; nothing paid`);
            return text({ ...hit, reused: true, paidThisCall: '0 USDC: the gate already held a bill of lading for these bytes (pass force to archive again)' });
          }
        }
        const facts = await door();
        if (bytes.length > facts.maxBodyBytes) {
          if (!payFetch) throw new Error('no LADING_X402_KEY: this shim can only call the free tools (wallet, describe, quote, lookup, verify)');
          return text(await multipartPut(bytes, sha, fileName, contentType, facts.partBytes, extra as Extra));
        }
        const { usdc } = await guard(`/v1/quote?size=${bytes.length}${force ? '' : `&sha=${sha}`}`, `archiving ${bytes.length} bytes`);
        log(`put ${fileName} ${bytes.length} B for ${usdc} USDC${force ? ' (forced)' : ''}`);
        const r = await paid('/v1/put', {
          method: 'POST',
          headers: {
            'content-type': contentType,
            'x-file-name': encodeURIComponent(fileName),
            'x-mime': contentType,
            // Declared so the door can answer a hash it already holds at the floor instead of buying every leg again.
            ...(force ? {} : { 'x-sha256': sha }),
          },
          body: bytes,
        });
        return text(r);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_verify',
    {
      title: 'Verify a bill of lading',
      description: 'Free. Re-fetches every leg named in a manifest (by ArNS name, Arweave txid or manifest URL) from its own network and compares sha256.',
      inputSchema: { ref: z.string().describe('ArNS name such as l-8c6b686168fd_boughtviatoonnode, a 43-char Arweave txid, or a URL') },
    },
    async ({ ref }) => {
      try {
        return text(await getJson(`/v1/verify?ref=${encodeURIComponent(ref)}`));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_renew',
    {
      title: 'Renew a Walrus record',
      description: 'PAID (quoted first). Buys one more year on Walrus for a record this gate uploaded, by its Lighthouse record id (in the walrus leg proof of a bill of lading as lighthouseId).',
      inputSchema: { lighthouseId: z.string().uuid().describe('Lighthouse record id from the walrus leg') },
    },
    async ({ lighthouseId }) => {
      try {
        const { usdc } = await guard(`/v1/renew/quote?id=${encodeURIComponent(lighthouseId)}`, 'the renewal');
        log(`renew ${lighthouseId} for ${usdc} USDC`);
        return text(await paid('/v1/renew', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lighthouseId }) }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected: gate=${gate} payer=${payer ?? 'none (free tools only)'} key=${resolved.from} cap=${o.maxUsdc} USDC`);
  // Keep the process alive until the client closes the pipe.
  await new Promise<void>((done) => {
    transport.onclose = () => done();
    process.stdin.on('end', () => done());
  });
}

/** The facilitator's settlement receipt from the response header: base64 JSON with the Base tx hash. */
function decodeReceipt(h: string): unknown {
  try {
    return JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
  } catch {
    return h;
  }
}
