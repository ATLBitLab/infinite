import { getStore, persistenceMisconfigured } from "@/lib/store";
import { archiveClipVideo, isArchivedUrl, storageEnabled } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Each clip is a 10-30 MB download plus upload; keep one call well inside
// the function's lifetime. Re-run (or raise ?limit=) until `remaining` is 0.
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/** Backfill: copy clips still served from fal into the R2 archive. Run by
 * hand with the cron secret after R2 is configured; new clips are archived
 * at creation, so this only ever has the pre-archive library to work
 * through, or clips whose archive copy failed at the time. */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    request.headers.get("authorization") !== `Bearer ${cronSecret}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (persistenceMisconfigured()) {
    return Response.json({ error: "Redis is required" }, { status: 503 });
  }
  if (!storageEnabled()) {
    return Response.json({ error: "R2 is not configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const requested = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LIMIT, Math.max(1, requested))
    : DEFAULT_LIMIT;

  const store = getStore();
  const locked = await store.acquireLock("archive-clips", maxDuration + 10);
  if (!locked) {
    return Response.json({ status: "already_running" }, { status: 202 });
  }
  const results: { clipId: string; status: "archived" | "error"; error?: string }[] = [];
  try {
    const pending = (await store.getClips()).filter((c) => !isArchivedUrl(c.videoUrl));
    for (const clip of pending.slice(0, limit)) {
      try {
        const videoUrl = await archiveClipVideo(clip.id, clip.videoUrl);
        await store.updateClipVideo(clip.id, videoUrl, clip.videoUrl);
        results.push({ clipId: clip.id, status: "archived" });
      } catch (err) {
        console.error(`archive backfill failed for ${clip.id}:`, err);
        results.push({ clipId: clip.id, status: "error", error: String(err).slice(0, 200) });
      }
    }
    return Response.json({
      status: "ok",
      archived: results.filter((r) => r.status === "archived").length,
      errors: results.filter((r) => r.status === "error").length,
      remaining: Math.max(0, pending.length - results.length),
      results,
    });
  } finally {
    await store.releaseLock("archive-clips");
  }
}
