import { randomUUID } from "crypto";
import {
  FAL_LOCK_FLAG,
  FAL_LOCK_TTL,
  extractLastFrame,
  falErrorDetail,
  generateVideo,
  generateVideoFromImage,
  isBalanceLock,
  mergeVideos,
} from "@/lib/fal";
import { deferJob, pruneMissingJob } from "@/lib/generation";
import { generateIdea } from "@/lib/llm";
import { moderateAndExpand } from "@/lib/llm";
import { scheduleClip } from "@/lib/stream";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import { config } from "@/lib/config";
import type { Clip, Job } from "@/lib/types";

export const dynamic = "force-dynamic";
// Video generation is fast (~9-15s) but leave generous headroom.
export const maxDuration = 300;

// Longer than this route's maximum lifetime. If an invocation is terminated,
// a viewer can safely reclaim the job after the lease expires.
const GENERATION_LEASE_MS = 330_000;
const GENERATION_DRAIN_LOCK_SECONDS = 330;
const DRAIN_RENDER_LIMIT = 2;
// Wide enough that a backlog of director jobs (recorder down) or dead
// members cannot hide the fal renders behind them.
const DRAIN_SCAN_LIMIT = 50;

/** Run a generation.
 *  - {jobId}: generate the clip for a PAID job.
 *  - {house: true}: generate auto-written filler content, guarded by a lock
 *    and a daily budget so viewers' players can bootstrap the stream without
 *    burning money.
 *  - {drain: true}: generate queued paid jobs, including retries after the
 *    render farm was temporarily unavailable. */
export async function POST(request: Request) {
  // Refuse to spend money on generations that a non-persistent store would
  // immediately forget (deployed without Redis → every instance is amnesiac).
  if (persistenceMisconfigured()) {
    return Response.json(
      {
        error:
          "Refusing to generate: no Redis configured, clips cannot persist on serverless. Add Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN) and redeploy.",
      },
      { status: 503 },
    );
  }

  let body: { jobId?: string; house?: boolean; drain?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  if (body.jobId) return generateForJob(body.jobId);
  if (body.drain) return drainDeferred();
  if (body.house) return generateHouse();
  return Response.json({ error: "jobId, drain, or house required" }, { status: 400 });
}

/** Run the fal generation for a paid job and schedule the clip.
 * Multi-scene episodes are chained for continuity — each scene's first frame
 * is the previous scene's last frame — then merged into one mp4, so one
 * purchase stays one Clip (players and /c/<id> permalinks depend on that).
 * Throws on generation failure (caller decides defer-vs-fail). */
async function runGeneration(job: Job) {
  const store = getStore();

  const prompts = job.scenePrompts?.length ? job.scenePrompts : [job.videoPrompt];
  const lengths = job.segmentDurations?.length === prompts.length
    ? job.segmentDurations
    : [job.duration ?? config.clipDuration];

  // Resume from any scenes a previous attempt already rendered: each scene
  // costs real money, and a failure in extract/merge must not re-bill them.
  const sceneUrls: string[] = (job.sceneUrls ?? []).slice(0, prompts.length);
  for (let i = 0; i < prompts.length; i++) {
    if (sceneUrls[i]) continue;
    const video =
      i === 0
        ? await generateVideo(prompts[0], lengths[0])
        : await generateVideoFromImage(
            prompts[i],
            await extractLastFrame(sceneUrls[i - 1]),
            lengths[i],
          );
    sceneUrls[i] = video.url;
    job.sceneUrls = sceneUrls;
    await store.putJob(job);
  }
  const videoUrl = await mergeVideos(sceneUrls);
  const totalDuration = lengths.reduce((sum, s) => sum + s, 0);

  const clip = await scheduleClip({
    id: randomUUID(),
    kind: "paid",
    idea: job.idea,
    title: job.title,
    videoPrompt: job.videoPrompt,
    videoUrl,
    duration: totalDuration,
    credit: job.credit,
    createdAt: Date.now(),
  } satisfies Omit<Clip, "airAt">);

  job.status = "done";
  job.clipId = clip.id;
  delete job.generationLeaseUntil;
  await store.putJob(job);
  return clip;
}

async function deferJobResponse(job: Job, err: unknown) {
  const status = await deferJob(job, err);
  return status === "failed"
    ? Response.json({ error: "generation failed repeatedly" }, { status: 500 })
    : Response.json({ status: "deferred" }, { status: 503 });
}

async function generateForJob(jobId: string) {
  const store = getStore();
  const existing = await store.getJob(jobId);
  if (!existing) {
    return Response.json({ error: "unknown job" }, { status: 404 });
  }
  // Director episodes are live sessions recorded by the recorder worker
  // (/api/director), not fal queue renders. Leave the job queued for it; the
  // client keeps polling /api/payment/<id> until the recorder marks it done.
  if (existing.renderer === "director") {
    if (existing.status === "done") {
      return Response.json({ status: "done", clipId: existing.clipId });
    }
    if (existing.status === "paid" || existing.status === "generating") {
      return Response.json({ status: "generating", renderer: "director" });
    }
    return Response.json(
      { error: `job is ${existing.status}, not paid` },
      { status: 409 },
    );
  }

  const job = await store.claimJobGeneration(jobId, GENERATION_LEASE_MS);
  if (!job) {
    const current = await store.getJob(jobId);
    if (!current) {
      return Response.json({ error: "unknown job" }, { status: 404 });
    }
    if (current.status === "done") {
      return Response.json({ status: "done", clipId: current.clipId });
    }
    if (current.status === "generating") {
      return Response.json({ status: "generating" });
    }
    return Response.json(
      { error: `job is ${current.status}, not paid` },
      { status: 409 },
    );
  }

  try {
    const clip = await runGeneration(job);
    return Response.json({ status: "done", clipId: clip.id, airAt: clip.airAt });
  } catch (err) {
    return deferJobResponse(job, err);
  }
}

/** Generate queued paid jobs. Every successful payment enters this durable
 * queue, and generation failures re-enter it. Viewers drain it opportunistically;
 * the endpoint is a cheap no-op when empty or while fal is locked. */
async function drainDeferred() {
  const store = getStore();
  if (await store.getFlag(FAL_LOCK_FLAG)) {
    return Response.json({ status: "fal_locked" }, { status: 202 });
  }
  const locked = await store.acquireLock(
    "drain",
    GENERATION_DRAIN_LOCK_SECONDS,
  );
  if (!locked) return Response.json({ status: "busy" }, { status: 202 });

  const results: { jobId: string; status: string }[] = [];
  try {
    // Director jobs share the queue but belong to the recorder worker; look
    // past them so they never starve the fal renders behind them.
    const jobIds = await store.claimPendingGenerationJobIds(DRAIN_SCAN_LIMIT);
    let rendered = 0;
    for (const jobId of jobIds) {
      if (rendered >= DRAIN_RENDER_LIMIT) break;
      const pending = await store.getJob(jobId);
      if (!pending) {
        await pruneMissingJob(jobId);
        continue;
      }
      if (pending.renderer === "director") continue;
      const job = await store.claimJobGeneration(jobId, GENERATION_LEASE_MS);
      if (!job) continue;
      rendered += 1;
      try {
        await runGeneration(job);
        results.push({ jobId, status: "done" });
      } catch (err) {
        await deferJob(job, err);
        results.push({ jobId, status: "deferred" });
        break; // fal is unhappy; stop draining this round
      }
    }
  } finally {
    await store.releaseLock("drain");
  }
  return Response.json({ status: "ok", results });
}

async function generateHouse() {
  const store = getStore();
  if (await store.getFlag(FAL_LOCK_FLAG)) {
    return Response.json({ status: "fal_locked" }, { status: 202 });
  }

  const dayKey = new Date().toISOString().slice(0, 10);
  // Lock prevents a thundering herd of viewers all triggering generations.
  const locked = await store.acquireLock("house-gen", 120);
  if (!locked) return Response.json({ status: "busy" }, { status: 202 });

  try {
    const count = await store.incrHouseCount(dayKey);
    if (count > config.maxDailyHouseClips) {
      return Response.json({ status: "budget_exhausted" }, { status: 429 });
    }

    const { idea } = await generateIdea();
    const moderation = await moderateAndExpand(idea);
    const video = await generateVideo(moderation.videoPrompt);
    const clip = await scheduleClip({
      id: randomUUID(),
      kind: "house",
      idea,
      title: moderation.title,
      videoPrompt: moderation.videoPrompt,
      videoUrl: video.url,
      duration: video.duration,
      createdAt: Date.now(),
    } satisfies Omit<Clip, "airAt">);

    return Response.json({ status: "done", clipId: clip.id });
  } catch (err) {
    console.error("house generation failed:", err);
    if (isBalanceLock(err)) {
      await store.setFlag(FAL_LOCK_FLAG, FAL_LOCK_TTL, falErrorDetail(err));
    }
    return Response.json({ error: "house generation failed" }, { status: 500 });
  } finally {
    await store.releaseLock("house-gen");
  }
}
