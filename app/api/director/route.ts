import { randomUUID } from "crypto";
import { timingSafeEqual } from "crypto";
import { config } from "@/lib/config";
import { RECORDER_ALIVE_FLAG, RECORDER_ALIVE_TTL, deferJob } from "@/lib/generation";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import { scheduleClip } from "@/lib/stream";
import type { Clip, Job } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Recorder worker API for H3 Max Director episodes.
 *
 * Director is a live WebRTC stream, not a queue render, so a paid director
 * job waits in the generation queue until the recorder worker (recorder/)
 * claims it here, records the session to an mp4, uploads it, and reports
 * back. Everything is authenticated with RECORDER_SECRET. */

// A 120s episode plus negotiation, transcode and upload fits comfortably; an
// interrupted recorder hands the job back when this expires.
const DIRECTOR_LEASE_MS = 15 * 60_000;
const CLAIM_SCAN_LIMIT = 20;

type Body =
  | { action: "claim" }
  | { action: "complete"; jobId: string; videoUrl: string; duration?: number }
  | { action: "fail"; jobId: string; error?: string };

function authorized(request: Request): boolean {
  const secret = config.recorderSecret;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!config.recorderSecret) {
    return Response.json({ error: "RECORDER_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (persistenceMisconfigured()) {
    return Response.json({ error: "no persistent store" }, { status: 503 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  switch (body.action) {
    case "claim":
      return claim();
    case "complete":
      return complete(body);
    case "fail":
      return fail(body);
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}

/** Hand the recorder the oldest due director job, leased for one attempt. */
async function claim() {
  const store = getStore();
  await store.setFlag(RECORDER_ALIVE_FLAG, RECORDER_ALIVE_TTL);
  const jobIds = await store.claimPendingGenerationJobIds(CLAIM_SCAN_LIMIT);
  for (const jobId of jobIds) {
    const pending = await store.getJob(jobId);
    if (pending?.renderer !== "director") continue;
    const job = await store.claimJobGeneration(jobId, DIRECTOR_LEASE_MS);
    if (!job) continue;
    if (!job.directorPremise || !job.scenePrompts?.length || !job.duration) {
      await deferJob(job, new Error("director job is missing its premise or beats"));
      continue;
    }
    return Response.json({
      status: "claimed",
      job: {
        jobId: job.id,
        title: job.title,
        premise: job.directorPremise,
        beats: job.scenePrompts,
        beatSeconds: config.directorBeatSeconds,
        duration: job.duration,
        model: config.directorModel,
        resolution: config.clipResolution.toLowerCase(),
        aspectRatio: "16:9",
        attempt: (job.retries ?? 0) + 1,
        leaseUntil: job.generationLeaseUntil,
      },
    });
  }
  return Response.json({ status: "idle" });
}

async function loadLeased(jobId: string): Promise<Job | Response> {
  const store = getStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });
  if (job.renderer !== "director") {
    return Response.json({ error: "not a director job" }, { status: 409 });
  }
  return job;
}

/** The recorder finished: schedule the clip. One purchase = one Clip. */
async function complete(body: { jobId: string; videoUrl: string; duration?: number }) {
  const loaded = await loadLeased(body.jobId);
  if (loaded instanceof Response) return loaded;
  const job = loaded;
  if (job.status === "done") {
    return Response.json({ status: "done", clipId: job.clipId });
  }
  if (job.status !== "generating") {
    return Response.json({ error: `job is ${job.status}, not generating` }, { status: 409 });
  }
  let url: URL;
  try {
    url = new URL(body.videoUrl);
  } catch {
    return Response.json({ error: "videoUrl must be a URL" }, { status: 400 });
  }
  if (url.protocol !== "https:") {
    return Response.json({ error: "videoUrl must be https" }, { status: 400 });
  }
  const duration = Number(body.duration);
  const clip = await scheduleClip({
    id: randomUUID(),
    kind: "paid",
    idea: job.idea,
    title: job.title,
    videoPrompt: job.videoPrompt,
    videoUrl: url.toString(),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : job.duration ?? 0,
    credit: job.credit,
    createdAt: Date.now(),
  } satisfies Omit<Clip, "airAt">);

  const store = getStore();
  job.status = "done";
  job.clipId = clip.id;
  delete job.generationLeaseUntil;
  await store.putJob(job);
  return Response.json({ status: "done", clipId: clip.id, airAt: clip.airAt });
}

/** The recorder gave up on this attempt: requeue (bounded, like fal renders). */
async function fail(body: { jobId: string; error?: string }) {
  const loaded = await loadLeased(body.jobId);
  if (loaded instanceof Response) return loaded;
  const job = loaded;
  if (job.status !== "generating") {
    return Response.json({ status: job.status });
  }
  const status = await deferJob(
    job,
    new Error(`recorder: ${String(body.error ?? "unknown error").slice(0, 300)}`),
  );
  return Response.json({ status });
}
