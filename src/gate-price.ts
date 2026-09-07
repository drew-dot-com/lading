/**
 * What the gate charges at the x402 door for a job whose TOON bill is known.
 * Pure: base units in, a USDC decimal string out. One place for the margin
 * and the floor so the free quote endpoint and the paid door cannot drift.
 *
 * The gate carries every route price (quotes included) and settles nothing
 * for a failed put, so the margin has to cover the odd leg that fails after
 * its route price is paid and the facilitator's own fee. The floor keeps a
 * tiny put from pricing under the Base transfer the facilitator pays for.
 */

/** 1 base unit on the TOON routes = 1 micro-USDC. */
export const UNITS_PER_USDC = 1_000_000n;

export interface GatePricing {
  /** Multiplier on the TOON bill, e.g. 1.2 for twenty percent over. */
  margin: number;
  /** Lowest price the door ever asks, USDC decimal string. */
  floorUsdc: string;
}

export const DEFAULT_PRICING: GatePricing = { margin: 1.2, floorUsdc: '0.05' };

/** Decimal USDC string to micro-units (six places, truncated). */
export function usdcToMicro(v: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`not a USDC amount: ${v}`);
  const [i, f = ''] = v.split('.');
  return BigInt(i) * UNITS_PER_USDC + BigInt((f + '000000').slice(0, 6));
}

/** Micro-units to a six-place decimal string, the form x402 takes as a Money price. */
export function microToUsdc(m: bigint): string {
  const i = m / UNITS_PER_USDC;
  const f = (m % UNITS_PER_USDC).toString().padStart(6, '0');
  return `${i}.${f}`;
}

/** The door price for a TOON bill of `units` base units: bill × margin, never under the floor, rounded up to the micro-unit. */
export function gatePriceMicro(units: bigint, pricing: GatePricing = DEFAULT_PRICING): bigint {
  if (units < 0n) throw new Error('negative bill');
  // margin as a fraction with 4 places so the arithmetic stays in bigint
  const m = BigInt(Math.round(pricing.margin * 10_000));
  if (m < 10_000n) throw new Error('margin under 1.0 would sell below cost');
  const scaled = units * m;
  const withMargin = scaled / 10_000n + (scaled % 10_000n === 0n ? 0n : 1n);
  const floor = usdcToMicro(pricing.floorUsdc);
  return withMargin > floor ? withMargin : floor;
}

export const gatePriceUsdc = (units: bigint, pricing: GatePricing = DEFAULT_PRICING) => microToUsdc(gatePriceMicro(units, pricing));

/** Read the pricing from the environment, defaults when unset. */
export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): GatePricing {
  const margin = env.LADING_GATE_MARGIN ? Number(env.LADING_GATE_MARGIN) : DEFAULT_PRICING.margin;
  if (!Number.isFinite(margin) || margin < 1) throw new Error(`LADING_GATE_MARGIN must be a number >= 1, got ${env.LADING_GATE_MARGIN}`);
  const floorUsdc = env.LADING_GATE_FLOOR_USDC ?? DEFAULT_PRICING.floorUsdc;
  usdcToMicro(floorUsdc);
  return { margin, floorUsdc };
}
