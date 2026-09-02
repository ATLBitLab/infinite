import { nowPlaying } from "@/lib/stream";
import { priceTableSats, submissionPriceSats } from "@/lib/price";
import { config, mockMode } from "@/lib/config";
import { getStore, persistenceMisconfigured, usingRedis } from "@/lib/store";
import { FAL_LOCK_FLAG } from "@/lib/fal";

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

  const [now, priceSats, priceTable, falLock, viewers, activity] = await Promise.all([
    nowPlaying(),
    submissionPriceSats(),
    priceTableSats(),
    store.getFlagInfo(FAL_LOCK_FLAG),
    store.getPresence(),
    store.getActivity(),
  ]);
  const falPaused = Boolean(falLock);
  const misconfigured = persistenceMisconfigured();
  return Response.json({
    ...now,
    // Never let clients trigger paid generations into a store that forgets.
    needsBootstrap: now.needsBootstrap && !misconfigured,
    priceSats,
    priceTable,
    durations: { min: config.clipMinDuration, max: config.clipDuration },
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
