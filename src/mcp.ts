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
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { usdcToMicro } from './gate-price.js';

export interface McpOptions {
  /** The gate's public URL. */
  gate: string;
  /** Hex Base private key that pays the door. Optional: without it only the free tools answer. */
  key?: string;
  /** USDC cap per paid call, decimal string. */
  maxUsdc: string;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

export async function runMcp(o: McpOptions) {
  const gate = o.gate.replace(/\/+$/, '');
  const maxMicro = usdcToMicro(o.maxUsdc);
  const log = (...a: unknown[]) => console.error('lading mcp:', ...a);

  let payFetch: typeof fetch | undefined;
  let payer: string | undefined;
  if (o.key) {
    const signer = privateKeyToAccount(o.key as `0x${string}`);
    payer = signer.address;
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    client.setSpendControls({ maxAmountPerPayment: o.maxUsdc });
    payFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
  }

  async function getJson(path: string): Promise<unknown> {
    const r = await fetch(`${gate}${path}`);
    const body = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`gate ${r.status}: ${String(body.error ?? JSON.stringify(body))}`);
    return body;
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
    if (!payFetch) throw new Error('no LADING_X402_KEY: this shim can only call the free tools (describe, quote, verify)');
    const r = await payFetch(`${gate}${path}`, init);
    const body = (await r.json().catch(() => ({ error: `gate answered ${r.status} with no JSON` }))) as Record<string, unknown>;
    if (r.status === 402) {
      // The door refused the payment itself: the reason rides in the PAYMENT-REQUIRED header, not the body.
      const pr = decodeReceipt(r.headers.get('payment-required') ?? '') as { error?: string; accepts?: Array<{ amount?: string }> } | string;
      const why = typeof pr === 'object' && pr?.error ? pr.error : 'payment refused';
      const amount = typeof pr === 'object' && pr?.accepts?.[0]?.amount ? ` (asked ${Number(pr.accepts[0].amount) / 1e6} USDC on Base from ${payer})` : '';
      throw new Error(`payment not accepted: ${why}${amount}. The payer needs USDC on Base; no ETH is needed.`);
    }
    if (!r.ok) throw new Error(`gate ${r.status}: ${String(body.error ?? JSON.stringify(body))}`);
    const receipt = r.headers.get('payment-response') ?? r.headers.get('x-payment-response');
    return receipt ? { ...body, x402: decodeReceipt(receipt) } : body;
  }

  const server = new McpServer({ name: 'lading', version: '0.6.0' });

  server.registerTool(
    'lading_describe',
    {
      title: 'Describe the Lading gate',
      description: 'What the hosted Lading gate sells (Arweave + Walrus + Filecoin archive with a signed bill of lading named on ArNS), its prices, the x402 network and payTo, and this shim\'s payer and cap.',
      inputSchema: {},
    },
    async () => {
      try {
        const d = await getJson('/v1/describe');
        return text({ ...(d as object), shim: { payer: payer ?? null, maxUsdcPerCall: o.maxUsdc, paidToolsEnabled: !!payFetch } });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'lading_quote',
    {
      title: 'Quote a Lading put',
      description: 'Free. The USDC price this door charges to archive an object of the given size (or the file at path), with the underlying TOON bill per leg.',
      inputSchema: { size: z.number().int().positive().optional().describe('object size in bytes'), path: z.string().optional().describe('local file to size instead') },
    },
    async ({ size, path }) => {
      try {
        const n = path ? statSync(resolve(path)).size : size;
        if (!n) return fail('give size or path');
        return text(await getJson(`/v1/quote?size=${n}`));
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
        'PAID (USDC on Base, quoted first, refused over the cap). Archives a local file (path) or a text string onto Arweave, Walrus and Filecoin through the TOON mesh, writes a signed bill of lading to Arweave and names it on ArNS. Returns every network receipt, the manifest URL and the ArNS name.',
      inputSchema: {
        path: z.string().optional().describe('local file to archive'),
        text: z.string().optional().describe('text to archive instead of a file'),
        name: z.string().optional().describe('file name to record (default: basename of path, or text.txt)'),
        mime: z.string().optional().describe('content type (default from the name, or text/plain for text)'),
      },
    },
    async ({ path, text: body, name, mime }) => {
      try {
        if (!path && body === undefined) return fail('give path or text');
        const bytes = path ? new Uint8Array(readFileSync(resolve(path))) : new TextEncoder().encode(body!);
        if (bytes.length === 0) return fail('nothing to archive: empty input');
        const fileName = name ?? (path ? basename(path) : 'text.txt');
        const contentType = mime ?? (path ? 'application/octet-stream' : 'text/plain; charset=utf-8');
        const { usdc } = await guard(`/v1/quote?size=${bytes.length}`, `archiving ${bytes.length} bytes`);
        log(`put ${fileName} ${bytes.length} B for ${usdc} USDC`);
        const r = await paid('/v1/put', {
          method: 'POST',
          headers: { 'content-type': contentType, 'x-file-name': encodeURIComponent(fileName), 'x-mime': contentType, 'content-length': String(bytes.length) },
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
  log(`connected: gate=${gate} payer=${payer ?? 'none (free tools only)'} cap=${o.maxUsdc} USDC`);
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
