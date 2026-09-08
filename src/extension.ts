/**
 * Entry point of the Claude Desktop extension (the .mcpb bundle).
 *
 * Same shim as `lading mcp`, configured from the manifest's user_config via
 * environment variables. The payer key is generated on first run at
 * ~/.lading/x402.key (0600) unless the user pasted one; nobody has to handle
 * a private key to get started, they fund the address `lading_wallet` shows.
 */
import { defaultKeyFile, runMcp } from './mcp.js';

const env = (k: string) => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

runMcp({
  gate: env('LADING_GATE') ?? 'https://lading.167-233-221-236.sslip.io',
  key: env('LADING_X402_KEY'),
  keyFile: env('LADING_X402_KEY_FILE') ?? defaultKeyFile(),
  autoKey: true,
  maxUsdc: env('LADING_MAX_USDC_PER_CALL') ?? '0.50',
  baseRpc: env('LADING_BASE_RPC'),
}).catch((e) => {
  console.error('lading extension:', (e as Error).message);
  process.exit(1);
});
