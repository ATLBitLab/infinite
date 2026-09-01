import { randomUUID } from "crypto";
import { generateVideo } from "@/lib/fal";
import { generateIdea } from "@/lib/llm";
import { moderateAndExpand } from "@/lib/llm";
import { scheduleClip } from "@/lib/stream";
import { getStore } from "@/lib/store";
import { config } from "@/lib/config";
import type { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";
// Video generation is fast (~9-15s) but leave generous headroom.
export const maxDuration = 300;

/** Run a generation.
 *  - {jobId}: generate the clip for a PAID job.
 *  - {house: true}: generate auto-written filler content, guarded by a lock
 *    and a daily budget so viewers' players can bootstrap the stream without
 *    burning money. */
export async function POST(request: Request) {
  let body: { jobId?: string; house?: boolean };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  if (body.jobId) return generateForJob(body.jobId);
  if (body.house) return generateHouse();
  return Response.json({ error: "jobId or house required" }, { status: 400 });
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

  job.status = "generating";
  await store.putJob(job);

  try {
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
    return Response.json({ status: "done", clipId: clip.id, airAt: clip.airAt });
  } catch (err) {
    console.error("generation failed:", err);
    job.status = "failed";
    job.error = "generation failed";
    await store.putJob(job);
    return Response.json({ error: "generation failed" }, { status: 500 });
  }
}

async function generateHouse() {
  const store = getStore();

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
    return Response.json({ error: "house generation failed" }, { status: 500 });
  } finally {
    await store.releaseLock("house-gen");
  }
}
