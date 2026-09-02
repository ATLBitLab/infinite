import { nowPlaying } from "@/lib/stream";
import { submissionPriceSats } from "@/lib/price";
import { mockMode } from "@/lib/config";
import { persistenceMisconfigured, usingRedis } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const [now, priceSats] = await Promise.all([
    nowPlaying(),
    submissionPriceSats(),
  ]);
  const misconfigured = persistenceMisconfigured();
  return Response.json({
    ...now,
    // Never let clients trigger paid generations into a store that forgets.
    needsBootstrap: now.needsBootstrap && !misconfigured,
    priceSats,
    mockMode,
    store: usingRedis() ? "redis" : "memory",
    configError: misconfigured
      ? "No Redis configured: clips cannot persist on serverless. Add Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN) and redeploy."
      : undefined,
  });
}
