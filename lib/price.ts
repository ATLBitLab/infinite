import { config } from "./config";

/** Submission price in sats. PRICE_SATS pins a fixed price; otherwise
 * PRICE_USD is converted at the current BTC spot rate (Coinbase public API,
 * cached ~5 min, with a conservative fallback rate if the fetch fails). */

const FALLBACK_BTC_USD = 100_000;

let cached: { rate: number; at: number } | null = null;

async function btcUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.rate;
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      signal: AbortSignal.timeout(4000),
    });
    const body = (await res.json()) as { data?: { amount?: string } };
    const rate = parseFloat(body.data?.amount ?? "");
    if (Number.isFinite(rate) && rate > 0) {
      cached = { rate, at: Date.now() };
      return rate;
    }
  } catch {
    // fall through to stale cache / fallback
  }
  return cached?.rate ?? FALLBACK_BTC_USD;
}

/** Price for a clip of the given duration. PRICE_SATS / PRICE_USD define the
 * price of a full-length clip (CLIP_DURATION); shorter clips scale linearly
 * per second. Rounded up to the nearest 100 sats with a floor of 100. */
export async function submissionPriceSats(
  durationSec: number = config.clipDuration,
): Promise<number> {
  const fraction = clampDuration(durationSec) / config.clipDuration;
  let sats: number;
  if (config.priceSats > 0) {
    sats = config.priceSats * fraction;
  } else {
    const rate = await btcUsd();
    sats = ((config.priceUsd * fraction) / rate) * 100_000_000;
  }
  return Math.max(100, Math.ceil(sats / 100) * 100);
}

export function clampDuration(durationSec: number): number {
  const d = Math.round(Number(durationSec));
  if (!Number.isFinite(d)) return config.clipDuration;
  return Math.min(config.maxTotalDuration, Math.max(config.clipMinDuration, d));
}

/** Exact sat price for every purchasable duration, for UI display. */
export async function priceTableSats(): Promise<Record<number, number>> {
  const table: Record<number, number> = {};
  for (let d = config.clipMinDuration; d <= config.maxTotalDuration; d++) {
    table[d] = await submissionPriceSats(d);
  }
  return table;
}

/** Split a purchased duration into fal-sized scene lengths (each 5–15s).
 * 20s → [10, 10]; 45s → [15, 15, 15]. */
export function splitSegments(totalSec: number): number[] {
  const total = clampDuration(totalSec);
  if (total <= config.clipDuration) return [total];
  const n = Math.ceil(total / config.clipDuration);
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}
