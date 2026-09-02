import { randomUUID } from "crypto";
import {
  FAL_LOCK_FLAG,
  FAL_LOCK_TTL,
  falErrorDetail,
  generateVideo,
  isBalanceLock,
} from "@/lib/fal";
import { generateIdea } from "@/lib/llm";
import { moderateAndExpand } from "@/lib/llm";
import { scheduleClip } from "@/lib/stream";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import { config } from "@/lib/config";
import type { Clip, Job } from "@/lib/types";

export const dynamic = "force-dynamic";
// Video generation is fast (~9-15s) but leave generous headroom.
export const maxDuration = 300;

const MAX_JOB_RETRIES = 5;

/** Run a generation.
 *  - {jobId}: generate the clip for a PAID job.
 *  - {house: true}: generate auto-written filler content, guarded by a lock
 *    and a daily budget so viewers' players can bootstrap the stream without
 *    burning money.
 *  - {drain: true}: retry deferred paid jobs (payments whose generation
 *    failed earlier, e.g. while fal was balance-locked). */
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
 * Throws on generation failure (caller decides defer-vs-fail). */
async function runGeneration(job: Job) {
  const store = getStore();
  job.status = "generating";
  await store.putJob(job);

  const video = await generateVideo(job.videoPrompt);
  const clip = await scheduleClip({
    id: randomUUID(),
    kind: "paid",
    idea: job.idea,
    title: job.title,
    videoPrompt: job.videoPrompt,
    videoUrl: video.url,
    duration: video.duration,
    credit: job.credit,
    createdAt: Date.now(),
  } satisfies Omit<Clip, "airAt">);

  job.status = "done";
  job.clipId = clip.id;
  await store.putJob(job);
  return clip;
}

/** A paid job must never die just because generation failed: put it back to
 * "paid", queue it for retry, and flag fal as locked when it's a balance
 * problem so submissions pause instead of eating more money. */
async function deferJob(job: Job, err: unknown) {
  const store = getStore();
  console.error(`generation failed for job ${job.id}:`, err);
  if (isBalanceLock(err)) {
    await store.setFlag(FAL_LOCK_FLAG, FAL_LOCK_TTL, falErrorDetail(err));
  }
  job.retries = (job.retries ?? 0) + 1;
  if (job.retries >= MAX_JOB_RETRIES) {
    job.status = "failed";
    job.error = "generation failed repeatedly";
    await store.putJob(job);
    return Response.json({ error: "generation failed repeatedly" }, { status: 500 });
  }
  job.status = "paid";
  await store.putJob(job);
  await store.pushDeferred(job.id);
  return Response.json({ status: "deferred" }, { status: 503 });
}

async function generateForJob(jobId: string) {
  const store = getStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });
  if (job.status === "done") {
    return Response.json({ status: "done", clipId: job.clipId });
  }
  if (job.status === "generating") {
    return Response.json({ status: "generating" });
  }
  if (job.status !== "paid") {
    return Response.json({ error: `job is ${job.status}, not paid` }, { status: 409 });
  }

  try {
    const clip = await runGeneration(job);
    return Response.json({ status: "done", clipId: clip.id, airAt: clip.airAt });
  } catch (err) {
    return deferJob(job, err);
  }
}

/** Retry queued paid jobs. Triggered opportunistically by viewers' players;
 * cheap no-op when the queue is empty or fal is still locked. */
async function drainDeferred() {
  const store = getStore();
  if (await store.getFlag(FAL_LOCK_FLAG)) {
    return Response.json({ status: "fal_locked" }, { status: 202 });
  }
  const locked = await store.acquireLock("drain", 120);
  if (!locked) return Response.json({ status: "busy" }, { status: 202 });

  const results: { jobId: string; status: string }[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const jobId = await store.popDeferred();
      if (!jobId) break;
      const job = await store.getJob(jobId);
      if (!job || job.status !== "paid") continue;
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
