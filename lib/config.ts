/** Central config. Every external service has a mock fallback so the app
 * runs locally with zero keys. Set the env vars to go live. */

export const config = {
  // fal.ai — video generation
  falKey: process.env.FAL_KEY ?? "",
  falModel: process.env.FAL_MODEL ?? "minimax/h3-max/text-to-video",
  clipDuration: intEnv("CLIP_DURATION", 15), // max seconds per fal generation, 5–15
  clipMinDuration: intEnv("CLIP_MIN_DURATION", 5), // shortest purchasable clip
  // Longest purchasable episode. Above clipDuration, an episode is written as
  // multiple scenes, chained via image-to-video for continuity, and merged
  // into a single mp4 (one purchase = one Clip = one permalink).
  maxTotalDuration: intEnv("MAX_TOTAL_DURATION", 45),
  clipResolution: (process.env.CLIP_RESOLUTION ?? "768P") as "480P" | "768P",

  // fal.ai H3 Max Director — one continuous, natively coherent take instead
  // of frame-chained scenes. It is a live WebRTC stream (no queue/mp4 API),
  // so episodes above maxTotalDuration are recorded by the recorder worker
  // (see recorder/). 0 disables the director tier; 120 is the longest
  // session fal allows without approval. Sessions bill 60s minimum.
  directorMaxDuration: intEnv("DIRECTOR_MAX_DURATION", 0),
  directorModel: process.env.FAL_DIRECTOR_MODEL ?? "minimax/h3-max/director",
  // Director generates fixed 10s chunks; the writers' room writes one beat
  // per chunk and the recorder sends the next beat as each chunk lands.
  directorBeatSeconds: 10,
  // Shared secret the recorder worker presents to /api/director.
  recorderSecret: process.env.RECORDER_SECRET ?? "",

  // Public origin of this deployment, for workers that call back into the
  // app (the sandbox recorder). Vercel supplies the production hostname.
  appUrl: (
    process.env.INFINITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000")
  ).replace(/\/+$/, ""),

  // Vercel Sandbox recorder: instead of a worker polling forever, every paid
  // director job spawns one microVM that clones this repo, runs
  // `recorder --once` against appUrl, and is stopped when the episode lands.
  sandbox: {
    enabled: process.env.RECORDER_SANDBOX === "1",
    // Optional pre-built VM image (recorder/sandbox-snapshot.mjs) so the
    // ~60s of dnf/Chromium/ffmpeg setup happens once, not per episode.
    snapshotId: process.env.RECORDER_SANDBOX_SNAPSHOT ?? "",
    repoUrl: process.env.RECORDER_REPO_URL ?? "https://github.com/ATLBitLab/infinite.git",
    // Pin the recorder to the deployed commit so app and worker never drift.
    repoRef: process.env.RECORDER_REPO_REF ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "main",
    timeoutMs: intEnv("RECORDER_SANDBOX_TIMEOUT_MS", 10 * 60_000),
    vcpus: intEnv("RECORDER_SANDBOX_VCPUS", 2),
    // On Vercel the SDK authenticates through OIDC; these are for local runs.
    token: process.env.VERCEL_TOKEN ?? "",
    teamId: process.env.VERCEL_TEAM_ID ?? "",
    projectId: process.env.VERCEL_PROJECT_ID ?? "",
  },

  // Cloudflare R2 clip archive. fal's CDN retention is configurable with no
  // documented default, so every finished mp4 is copied into a bucket we own
  // and served from there. All five unset = keep serving from fal.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
    // Public base URL of the bucket (r2.dev subdomain or a custom domain).
    publicUrl: (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, ""),
  },

  // Anthropic — ideas, moderation, prompt expansion
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",

  // Voltage — bitcoin payments
  voltage: {
    apiKey: process.env.VOLTAGE_API_KEY ?? "",
    orgId: (process.env.VOLTAGE_ORG_ID ?? "").toLowerCase(),
    envId: (process.env.VOLTAGE_ENV_ID ?? "").toLowerCase(),
    walletId: (process.env.VOLTAGE_WALLET_ID ?? "").toLowerCase(),
    baseUrl: process.env.VOLTAGE_API_URL ?? "https://voltageapi.com/v1",
    // Returned once when the environment webhook is registered. The webhook
    // id lets us reject deliveries intended for a different registration.
    webhookId: (process.env.VOLTAGE_WEBHOOK_ID ?? "").toLowerCase(),
    webhookSecret: process.env.VOLTAGE_WEBHOOK_SECRET ?? "",
  },

  // Pricing: PRICE_SATS pins a fixed sat price; otherwise PRICE_USD is
  // converted to sats at the current exchange rate at invoice time.
  priceSats: intEnv("PRICE_SATS", 0),
  priceUsd: floatEnv("PRICE_USD", 2.0),
  // Cost floor: a purchase never sells below what it costs us times
  // PRICE_MARKUP (see lib/price.ts estimatedCostUsd). Rates are fal's list
  // prices at 768p (promo rates expire 2026-09-07 for video, 09-14 for
  // director); override when fal changes them.
  cost: {
    videoUsdPerSec: floatEnv("FAL_VIDEO_USD_PER_SEC", 0.08),
    directorUsdPerSec: floatEnv("FAL_DIRECTOR_USD_PER_SEC", 0.08),
    // "Sessions are billed at a minimum of 60 seconds runtime."
    directorMinBilledSec: intEnv("FAL_DIRECTOR_MIN_SEC", 60),
    // extract-frame + merge calls per chained scene (fal ffmpeg-api).
    sceneOverheadUsd: floatEnv("SCENE_OVERHEAD_USD", 0.02),
    // Vercel Sandbox time for one recorded episode (CPU + memory + transfer).
    sandboxUsdPerEpisode: floatEnv("SANDBOX_USD_PER_EPISODE", 0.05),
    // Writers' room + moderation calls.
    llmUsdPerJob: floatEnv("LLM_USD_PER_JOB", 0.02),
    // Price floor = cost × markup (1.5 = 50% gross margin over cost).
    markup: floatEnv("PRICE_MARKUP", 1.5),
  },

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
