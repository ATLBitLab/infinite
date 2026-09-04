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

// H3 Max Director generates 10s chunks of which ~8.5s is new playback (the
// rest is continuation context), and fal bills every generated second. A
// session ends itself after 13 chunks (observed 2026-09-04: 103s delivered,
// ~130s billed), so that is the most one purchase can cost.
const DIRECTOR_CHUNK_SEC = 10;
const DIRECTOR_CHUNK_PLAYBACK_SEC = 8.5;
const DIRECTOR_SESSION_MAX_CHUNKS = 13;

/** What one purchase of this length costs us, in USD, at the configured
 * rates: fal generation (plus per-scene ffmpeg calls for chained episodes,
 * or the sandbox VM for director episodes) and the writers' room. */
export function estimatedCostUsd(durationSec: number = config.clipDuration): number {
  const d = clampDuration(durationSec);
  const c = config.cost;
  if (isDirectorDuration(d)) {
    const chunks = Math.min(
      DIRECTOR_SESSION_MAX_CHUNKS,
      Math.ceil(d / DIRECTOR_CHUNK_PLAYBACK_SEC),
    );
    const billedSec = Math.max(c.directorMinBilledSec, chunks * DIRECTOR_CHUNK_SEC);
    return billedSec * c.directorUsdPerSec + c.sandboxUsdPerEpisode + c.llmUsdPerJob;
  }
  const segments = splitSegments(d);
  const seconds = segments.reduce((sum, s) => sum + s, 0);
  const overhead = segments.length > 1 ? segments.length * c.sceneOverheadUsd : 0;
  return seconds * c.videoUsdPerSec + overhead + c.llmUsdPerJob;
}

/** Price for a clip of the given duration. PRICE_SATS / PRICE_USD define the
 * price of a full-length clip (CLIP_DURATION); shorter clips scale linearly
 * per second. Never below estimatedCostUsd × PRICE_MARKUP, so a purchase
 * always covers what fal and the sandbox charge us. Rounded up to the
 * nearest 100 sats with a floor of 100. */
export async function submissionPriceSats(
  durationSec: number = config.clipDuration,
): Promise<number> {
  const d = clampDuration(durationSec);
  const fraction = d / config.clipDuration;
  const rate = await btcUsd();
  const usdToSats = (usd: number) => (usd / rate) * 100_000_000;
  const listSats =
    config.priceSats > 0 ? config.priceSats * fraction : usdToSats(config.priceUsd * fraction);
  const floorSats = usdToSats(estimatedCostUsd(d) * config.cost.markup);
  const sats = Math.max(listSats, floorSats);
  return Math.max(100, Math.ceil(sats / 100) * 100);
}

/** True when the director tier is on: durations above the chained-scene
 * ceiling are sold as one continuous H3 Max Director take. */
export function directorEnabled(): boolean {
  return config.directorMaxDuration > config.maxTotalDuration;
}

/** Longest purchasable episode across both render paths. */
export function maxPurchasableDuration(): number {
  return directorEnabled() ? config.directorMaxDuration : config.maxTotalDuration;
}

/** Durations the chained-scene path cannot serve go to the director. */
export function isDirectorDuration(durationSec: number): boolean {
  return directorEnabled() && durationSec > config.maxTotalDuration;
}

export function clampDuration(durationSec: number): number {
  const d = Math.round(Number(durationSec));
  if (!Number.isFinite(d)) return config.clipDuration;
  return Math.min(maxPurchasableDuration(), Math.max(config.clipMinDuration, d));
}

/** Exact sat price for every purchasable duration, for UI display. */
export async function priceTableSats(): Promise<Record<number, number>> {
  const table: Record<number, number> = {};
  for (let d = config.clipMinDuration; d <= maxPurchasableDuration(); d++) {
    table[d] = await submissionPriceSats(d);
  }
  return table;
}

/** Split a purchased duration into render segments.
 * Chained scenes are fal-sized (each 5–15s): 20s → [10, 10]; 45s → [15, 15, 15].
 * Director episodes are 10s beats matching the model's chunk cadence:
 * 95s → [10 ×9, 5]. */
export function splitSegments(totalSec: number): number[] {
  const total = clampDuration(totalSec);
  if (isDirectorDuration(total)) {
    const beat = config.directorBeatSeconds;
    const n = Math.ceil(total / beat);
    return Array.from({ length: n }, (_, i) =>
      i < n - 1 ? beat : total - beat * (n - 1),
    );
  }
  if (total <= config.clipDuration) return [total];
  const n = Math.ceil(total / config.clipDuration);
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}
