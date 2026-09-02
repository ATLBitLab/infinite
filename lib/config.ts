/** Central config. Every external service has a mock fallback so the app
 * runs locally with zero keys. Set the env vars to go live. */

export const config = {
  // fal.ai — video generation
  falKey: process.env.FAL_KEY ?? "",
  falModel: process.env.FAL_MODEL ?? "minimax/h3-max/text-to-video",
  clipDuration: intEnv("CLIP_DURATION", 15), // seconds, 5–15
  clipResolution: (process.env.CLIP_RESOLUTION ?? "768P") as "480P" | "768P",

  // Anthropic — ideas, moderation, prompt expansion
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",

  // Voltage — bitcoin payments
  voltage: {
    apiKey: process.env.VOLTAGE_API_KEY ?? "",
    orgId: process.env.VOLTAGE_ORG_ID ?? "",
    envId: process.env.VOLTAGE_ENV_ID ?? "",
    walletId: process.env.VOLTAGE_WALLET_ID ?? "",
    baseUrl: process.env.VOLTAGE_API_URL ?? "https://voltageapi.com/v1",
  },

  // Pricing: PRICE_SATS pins a fixed sat price; otherwise PRICE_USD is
  // converted to sats at the current exchange rate at invoice time.
  priceSats: intEnv("PRICE_SATS", 0),
  priceUsd: floatEnv("PRICE_USD", 2.0),

  // House content (auto-generated filler) budget guardrails.
  maxDailyHouseClips: intEnv("MAX_DAILY_HOUSE_CLIPS", 12),
  minLibraryClips: intEnv("MIN_LIBRARY_CLIPS", 3),
  // Keep the channel fresh: generate a house clip when the newest clip is
  // older than this many hours AND someone is watching. 0 disables (bootstrap
  // only). Daily budget cap still applies.
  houseFreshHours: floatEnv("HOUSE_FRESH_HOURS", 4),

  // Upstash Redis (falls back to in-memory for local dev)
  redisUrl: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "",
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "",
};

export const mockMode = {
  fal: !config.falKey,
  llm: !config.anthropicKey,
  voltage: !(
    config.voltage.apiKey &&
    config.voltage.orgId &&
    config.voltage.envId &&
    config.voltage.walletId
  ),
};

/** The house style baked into every video prompt. */
export const STYLE_PROMPT =
  "2D limited-animation cartoon in the style of early-2000s late-night adult animation: " +
  "flat cel-shaded colors, thick confident black outlines, angular retro-futurist character design, " +
  "Y2K color palette (teal, burnt orange, mustard, off-white), dramatic comic-book compositions, " +
  "deadpan action poses, VHS-era broadcast titles. No photorealism.";

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : fallback;
}
