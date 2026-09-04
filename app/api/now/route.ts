import { nowPlaying } from "@/lib/stream";
import { directorEnabled, maxPurchasableDuration, priceTableSats, submissionPriceSats } from "@/lib/price";
import { config, mockMode } from "@/lib/config";
import { getStore, persistenceMisconfigured, usingRedis } from "@/lib/store";
import { FAL_LOCK_FLAG } from "@/lib/fal";
import { directorAvailable } from "@/lib/generation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const store = getStore();

  // Presence heartbeat: ?vid=<pubkey-prefix>&vn=<display name>
  const url = new URL(request.url);
  const vid = (url.searchParams.get("vid") ?? "").replace(/[^a-f0-9]/gi, "").slice(0, 16);
  const vn = (url.searchParams.get("vn") ?? "")
    .replace(/[|\n\r]/g, " ")
    .trim()
    .slice(0, 30);
  if (vid) await store.touchPresence(vid, vn || "viewer");

  const [now, priceSats, priceTable, falLock, viewers, activity, recorderUp] =
    await Promise.all([
      nowPlaying(),
      submissionPriceSats(),
      priceTableSats(),
      store.getFlagInfo(FAL_LOCK_FLAG),
      store.getPresence(),
      store.getActivity(),
      directorAvailable(),
    ]);
  // Director-length episodes are only on sale while something will record them.
  const directorOpen = directorEnabled() && recorderUp;
  const falPaused = Boolean(falLock);
  const misconfigured = persistenceMisconfigured();
  return Response.json({
    ...now,
    // Never let clients trigger paid generations into a store that forgets.
    needsBootstrap: now.needsBootstrap && !misconfigured,
    priceSats,
    priceTable,
    durations: {
      min: config.clipMinDuration,
      max: directorOpen ? maxPurchasableDuration() : config.maxTotalDuration,
      // Above this, an episode is one continuous H3 Max Director take.
      directorAbove: directorOpen ? config.maxTotalDuration : undefined,
    },
    mockMode,
    falPaused,
    falPausedReason: falLock?.reason || undefined,
    falPausedAt: falLock?.ts || undefined,
    viewers,
    activity,
    store: usingRedis() ? "redis" : "memory",
    configError: misconfigured
      ? "No Redis configured: clips cannot persist on serverless. Add Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN) and redeploy."
      : undefined,
  });
}
