/**
 * Float rows: what each hot key must hold for its leg to go through, judged
 * once and reported in one place. The broker answers `GET /floats` for its
 * three keys (Walrus USDC on Base, Filecoin Pay runway, the ArNS name key's
 * SOL); the gate adds its own TOON payer (USDC and SOL on Solana, plus the
 * open channel's headroom) and publishes the whole list under `health` in
 * `GET /v1/describe`. refuel polls that door every half hour: rows it can
 * fill from a treasury are also in its floats.json, rows it cannot (Filecoin)
 * become a push naming the address and what to send. Nothing here alerts on
 * its own; reporting and deciding stay apart.
 */
import { createSolanaRpc, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export interface FloatRow {
  /** Stable id refuel keys alerts on: `walrus-float`, `filecoin-runway`, `name-key`, `gate-payer-usdc`, `gate-payer-sol`. */
  name: string;
  /** What runs dry when it is empty. */
  role: string;
  chain: string;
  asset: string;
  address: string;
  /** Human units, decimal string. */
  balance: string;
  /** Under this the row is not ok. Human units. */
  low: string;
  ok: boolean;
  /** What to send where when the row is not ok. */
  fund: string;
  /** Anything else worth a glance: runway days, channel headroom, FIL for gas. */
  extra?: Record<string, string | number | null>;
}

export interface FloatsReport {
  ok: boolean;
  /** Names of the rows that are not ok. */
  low: string[];
  floats: FloatRow[];
  at: number;
}

/** Decimal strings compared exactly: 18 places covers wei. */
export function cmpDecimal(a: string, b: string): number {
  const toInt = (v: string) => {
    const neg = v.trim().startsWith('-');
    const [i, f = ''] = v.trim().replace(/^-/, '').split('.');
    const n = BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
    return neg ? -n : n;
  };
  const x = toInt(a);
  const y = toInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** One row, judged: ok when the balance is not under `low`. */
export function judge(row: Omit<FloatRow, 'ok'>): FloatRow {
  return { ...row, ok: cmpDecimal(row.balance, row.low) >= 0 };
}

export function report(floats: FloatRow[], at = Math.floor(Date.now() / 1000)): FloatsReport {
  const low = floats.filter((f) => !f.ok).map((f) => f.name);
  return { ok: low.length === 0, low, floats, at };
}

/** Lamports as a SOL decimal string, exact. */
export const lamportsToSol = (l: bigint) => `${l / 1_000_000_000n}.${(l % 1_000_000_000n).toString().padStart(9, '0')}`.replace(/\.?0+$/, '') || '0';
/** Micro-units as a six-place decimal string. */
export const microToDecimal = (u: bigint) => `${u / 1_000_000n}.${(u % 1_000_000n).toString().padStart(6, '0')}`;

// ---- Solana reads for the gate's payer ----

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * SOL and USDC held by one Solana address. The USDC read derives the owner's
 * associated token account and decodes the amount from the raw account bytes
 * (u64 at offset 64): public RPCs refuse the indexed owner queries and the
 * parsed balance call, and every key here uses its ATA. A missing account is 0.
 */
export async function solanaHoldings(rpcUrl: string, owner: string, mint = SOLANA_USDC_MINT): Promise<{ lamports: bigint; usdcMicro: bigint }> {
  const rpc = createSolanaRpc(rpcUrl);
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(mint))],
  });
  const [bal, acct] = await Promise.all([rpc.getBalance(address(owner)).send(), rpc.getAccountInfo(ata, { encoding: 'base64' }).send()]);
  const usdcMicro = acct.value ? Buffer.from(acct.value.data[0], 'base64').readBigUInt64LE(64) : 0n;
  return { lamports: BigInt(bal.value), usdcMicro };
}
