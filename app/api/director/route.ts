import { randomUUID, timingSafeEqual } from "crypto";
import { after } from "next/server";
import { config, mockMode } from "@/lib/config";
import { FAL_LOCK_FLAG, FAL_LOCK_TTL } from "@/lib/fal";
import {
  RECORDER_ALIVE_FLAG,
  RECORDER_ALIVE_TTL,
  deferJob,
  failJobTerminal,
  pruneMissingJob,
} from "@/lib/generation";
import { releaseRecorderSandbox } from "@/lib/sandbox";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import { archiveOrKeep } from "@/lib/storage";
import { scheduleClip } from "@/lib/stream";
import type { Clip, Job } from "@/lib/types";

export const dynamic = "force-dynamic";
// Completing an episode copies a 25+ MB mp4 into the archive.
export const maxDuration = 120;

/** Recorder worker API for H3 Max Director episodes.
 *
 * Director is a live WebRTC stream, not a queue render, so a paid director
 * job waits in the generation queue until the recorder worker (recorder/)
 * claims it here, records the session to an mp4, uploads it, and reports
 * back. Everything is authenticated with RECORDER_SECRET, and every
 * complete/fail must present the lease it was handed at claim time so a
 * recorder that overran its lease cannot finish or requeue a job another
 * recorder now owns. */

// A 120s episode plus negotiation, transcode and upload fits comfortably; an
// interrupted recorder hands the job back when this expires.
const DIRECTOR_LEASE_MS = 15 * 60_000;
// Wide enough that a fal backlog (drain refusing while fal is locked) or dead
// members cannot hide the director jobs behind them.
const CLAIM_SCAN_LIMIT = 50;
// Every claim opens a billed live session (60s minimum), and a recorder that
// crashes mid-episode never reports a failure, so attempts are counted here
// rather than only in deferJob. Tighter than the fal path's retry cap.
const MAX_CLAIM_ATTEMPTS = 3;

type Body =
  | {
      action: "claim";
      mode?: "director" | "fake";
      keepAlive?: boolean;
      /** A sandbox recorder exists for exactly one job: claim only that one. */
      jobId?: string;
    }
  | {
      action: "complete";
      jobId: string;
      lease?: number;
      videoUrl: string;
      duration?: number;
    }
  | {
      action: "fail";
      jobId: string;
      lease?: number;
      error?: string;
      code?: string;
      /** false = the same input would fail again; do not spend another session. */
      retryable?: boolean;
      /** fal refused the session for lack of funds: pause all sales. */
      balanceLock?: boolean;
    };

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
      return claim(body);
    case "complete":
      return complete(body);
    case "fail":
      return fail(body);
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}

/** Hand the recorder the oldest due director job, leased for one attempt. */
async function claim(body: { mode?: string; keepAlive?: boolean; jobId?: string }) {
  const store = getStore();
  // A fake (canvas) recorder must never complete real purchases: only a
  // station with no fal key (mock mode) may hand it jobs.
  if (body.mode === "fake" && !mockMode.fal) {
    return Response.json(
      { error: "fake recorder refused: this station has a real FAL_KEY" },
      { status: 403 },
    );
  }
  // A one-shot run (--once) does not keep polling, so it must not advertise
  // director lengths for sale.
  if (body.keepAlive !== false) {
    await store.setFlag(RECORDER_ALIVE_FLAG, RECORDER_ALIVE_TTL);
  }

  const jobIds = body.jobId
    ? [body.jobId]
    : await store.claimPendingGenerationJobIds(CLAIM_SCAN_LIMIT);
  for (const jobId of jobIds) {
    const pending = await store.getJob(jobId);
    if (!pending) {
      await pruneMissingJob(jobId);
      continue;
    }
    if (pending.renderer !== "director") continue;
    const job = await store.claimJobGeneration(jobId, DIRECTOR_LEASE_MS);
    if (!job) continue;
    if (!job.directorPremise || !job.scenePrompts?.length || !job.duration) {
      await failJobTerminal(job, "director job is missing its premise or beats");
      continue;
    }
    job.claimAttempts = (job.claimAttempts ?? 0) + 1;
    if (job.claimAttempts > MAX_CLAIM_ATTEMPTS) {
      await failJobTerminal(job, "recorder gave up: too many live sessions for one episode");
      continue;
    }
    await store.putJob(job);
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
        attempt: job.claimAttempts,
        lease: job.generationLeaseUntil,
      },
    });
  }
  return Response.json({ status: "idle" });
}

/** Load a director job and check the caller still holds its lease. */
async function loadLeased(
  jobId: string,
  lease: number | undefined,
): Promise<Job | Response> {
  const store = getStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });
  if (job.renderer !== "director") {
    return Response.json({ error: "not a director job" }, { status: 409 });
  }
  if (job.status === "done") {
    return Response.json({ status: "done", clipId: job.clipId });
  }
  if (job.status !== "generating") {
    return Response.json({ error: `job is ${job.status}, not generating` }, { status: 409 });
  }
  if (!lease || job.generationLeaseUntil !== lease) {
    return Response.json({ error: "stale lease: another recorder owns this job" }, { status: 409 });
  }
  return job;
}

/** The recorder finished: schedule the clip. One purchase = one Clip, even
 * if this call is retried after a partial failure. */
async function complete(body: {
  jobId: string;
  lease?: number;
  videoUrl: string;
  duration?: number;
}) {
  const loaded = await loadLeased(body.jobId, body.lease);
  if (loaded instanceof Response) return loaded;
  const job = loaded;
  const store = getStore();

  let url: URL;
  try {
    url = new URL(body.videoUrl);
  } catch {
    return Response.json({ error: "videoUrl must be a URL" }, { status: 400 });
  }
  if (url.protocol !== "https:") {
    return Response.json({ error: "videoUrl must be https" }, { status: 400 });
  }

  // Checkpoint the outcome before scheduling: a retry after a crash between
  // these writes finds the clip id already fixed and only schedules it if
  // the previous attempt did not get that far.
  if (!job.clipId || !job.directorVideoUrl) {
    job.clipId = randomUUID();
    job.directorVideoUrl = url.toString();
    await store.putJob(job);
  }
  const clips = await store.getClips();
  let clip = clips.find((c) => c.id === job.clipId);
  if (!clip) {
    const duration = Number(body.duration);
    const { videoUrl, sourceUrl } = await archiveOrKeep(job.clipId, job.directorVideoUrl);
    clip = await scheduleClip({
      id: job.clipId,
      kind: "paid",
      idea: job.idea,
      title: job.title,
      videoPrompt: job.videoPrompt,
      videoUrl,
      sourceUrl,
      duration:
        Number.isFinite(duration) && duration > 0 ? Math.round(duration) : job.duration ?? 0,
      credit: job.credit,
      createdAt: Date.now(),
    } satisfies Omit<Clip, "airAt">);
  }

  job.status = "done";
  delete job.generationLeaseUntil;
  await store.putJob(job);
  releaseSandbox(job);
  return Response.json({ status: "done", clipId: clip.id, airAt: clip.airAt });
}

/** A sandbox recorder has nothing left to do once it has reported; stop it
 * after this response is sent so it is not billed until its timeout. */
function releaseSandbox(job: Job) {
  after(() => releaseRecorderSandbox(job.id));
}

/** The recorder gave up on this attempt. Retryable failures requeue
 * (bounded by MAX_CLAIM_ATTEMPTS); deterministic ones stop immediately so
 * the same rejected prompt is not billed again and again. */
async function fail(body: {
  jobId: string;
  lease?: number;
  error?: string;
  code?: string;
  retryable?: boolean;
  balanceLock?: boolean;
}) {
  const loaded = await loadLeased(body.jobId, body.lease);
  if (loaded instanceof Response) return loaded;
  const job = loaded;
  const detail = `recorder: ${String(body.error ?? "unknown error").slice(0, 300)}`;

  if (body.balanceLock) {
    await getStore().setFlag(FAL_LOCK_FLAG, FAL_LOCK_TTL, detail);
  }
  if (body.retryable === false) {
    await failJobTerminal(job, detail);
    releaseSandbox(job);
    return Response.json({ status: "failed" });
  }
  const status = await deferJob(job, new Error(detail));
  // A requeued job gets a fresh sandbox from the next drain/generate call;
  // this one has already spent its session.
  releaseSandbox(job);
  return Response.json({ status });
}
