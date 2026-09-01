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

export async function submissionPriceSats(): Promise<number> {
  if (config.priceSats > 0) return config.priceSats;
  const rate = await btcUsd();
  const sats = (config.priceUsd / rate) * 100_000_000;
  // Round up to the nearest 100 sats so the price looks intentional.
  return Math.max(100, Math.ceil(sats / 100) * 100);
}
