import { randomUUID } from "crypto";
import { after } from "next/server";
import { clampDuration, isDirectorDuration, splitSegments } from "@/lib/price";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import { FAL_LOCK_FLAG } from "@/lib/fal";
import { directorAvailable } from "@/lib/generation";
import { config } from "@/lib/config";
import { verifyNip98 } from "@/lib/nip98";
import { prepareSubmission } from "@/lib/submission-preflight";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Persist a submission immediately. The slow writers' room runs after this
 * response and must finish before it can request a Lightning invoice. */
export async function POST(request: Request) {
  // An already-open predeploy tab would mislabel the new preparing response as
  // invoice generation. Fail it before creating a job so it asks for a refresh
  // instead of reviving the misleading Voltage wait screen.
  if (request.headers.get("x-infinite-submit-version") !== "2") {
    return Response.json(
      { error: "The submission flow was updated. Refresh the page and try again." },
      { status: 409 },
    );
  }
  // Never take someone's sats for a job a non-persistent store would forget.
  if (persistenceMisconfigured()) {
    return Response.json(
      { error: "The station is misconfigured (no Redis). Submissions are paused." },
      { status: 503 },
    );
  }
  // Never take someone's sats while the render farm is balance-locked.
  const store = getStore();
  if (await store.getFlag(FAL_LOCK_FLAG)) {
    return Response.json(
      { error: "The render farm is refueling — submissions are paused for a few minutes. Your sats are safe in your wallet where they belong." },
      { status: 503 },
    );
  }
  let raw: string;
  let body: { idea?: string; credit?: string; duration?: number };
  try {
    raw = await request.text();
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  // Optional NIP-98 proof of the browser identity, used only for /me history.
  // A missing or bad signature never blocks a purchase; the job just records
  // no creator.
  const creatorPubkey = verifyNip98(request, raw) ?? undefined;

  const idea = (body.idea ?? "").trim().slice(0, 500);
  const credit = (body.credit ?? "").trim().slice(0, 50) || undefined;
  // Server-side clamp: the client's slider is presentation only.
  const duration = clampDuration(body.duration ?? config.clipDuration);
  if (idea.length < 5) {
    return Response.json({ error: "Give us a little more than that." }, { status: 400 });
  }
  // Director episodes only exist if something will record them (a polling
  // worker or a sandbox we can spawn); never take sats for a live session
  // nobody would record.
  const renderer = isDirectorDuration(duration) ? "director" : "fal";
  if (renderer === "director" && !(await directorAvailable())) {
    return Response.json(
      { error: `The director is off set right now — episodes up to ${config.maxTotalDuration}s are still open.` },
      { status: 503 },
    );
  }
  try {
    const segments = splitSegments(duration);
    // Payment IDs are always server-generated. Reusing a caller-controlled ID
    // after our Redis TTL could otherwise attach an old paid invoice to a new
    // prompt during reconciliation.
    const jobId = randomUUID();
    const job: Job = {
      id: jobId,
      status: "preparing",
      idea,
      title: "",
      videoPrompt: "",
      credit,
      creatorPubkey,
      duration,
      renderer,
      segmentDurations: segments,
      createdAt: Date.now(),
    };
    const stored = await store.createPreparingJob(job);
    if (creatorPubkey) {
      await store
        .indexCreatorJob(creatorPubkey, jobId, job.createdAt)
        .catch((err) => console.error("creator job index failed:", err));
    }

    after(() => prepareSubmission(jobId));

    return Response.json(
      {
        jobId,
        status: stored.status,
      },
      { status: 202 },
    );
  } catch (err) {
    console.error("submit failed:", err);
    return Response.json({ error: "Something broke backstage. Try again." }, { status: 500 });
  }
}
