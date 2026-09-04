import { FAL_LOCK_FLAG, FAL_LOCK_TTL, falErrorDetail, isBalanceLock } from "./fal";
import { getStore } from "./store";
import type { Job } from "./types";

export const MAX_JOB_RETRIES = 5;

/** Store flag key touched by every recorder claim. While it is fresh a
 * recorder worker is polling, so director-length episodes may be sold;
 * when it lapses the slider shrinks back to chained scenes so no one pays
 * for a session nothing would record. */
export const RECORDER_ALIVE_FLAG = "recorder-alive";
export const RECORDER_ALIVE_TTL = 180; // seconds; the worker polls every 15s

export async function recorderAlive(): Promise<boolean> {
  return getStore().getFlag(RECORDER_ALIVE_FLAG);
}

/** Give up on a paid job for good (the caller has decided a retry cannot
 * help). Terminal state keeps the payment record instead of letting the job
 * silently age out of the queue. */
export async function failJobTerminal(job: Job, error: string): Promise<void> {
  console.error(`job ${job.id} failed terminally: ${error}`);
  job.status = "failed";
  job.error = error.slice(0, 300);
  job.failureStage = "generation";
  delete job.generationLeaseUntil;
  await getStore().putJob(job);
}

/** Drop a generation-queue member whose job record is gone (expired TTL,
 * legacy id). claimJobGeneration's script removes the member when the key
 * is missing, so a 1ms lease is a harmless way to invoke that healing. */
export async function pruneMissingJob(jobId: string): Promise<void> {
  await getStore().claimJobGeneration(jobId, 1);
}

/** A paid job must never die just because generation failed: put it back to
 * "paid", queue it for retry, and flag fal as locked when it's a balance
 * problem so submissions pause instead of eating more money.
 * Returns the job's new status. */
export async function deferJob(job: Job, err: unknown): Promise<"paid" | "failed"> {
  const store = getStore();
  console.error(`generation failed for job ${job.id}:`, err);
  if (isBalanceLock(err)) {
    await store.setFlag(FAL_LOCK_FLAG, FAL_LOCK_TTL, falErrorDetail(err));
  }
  job.retries = (job.retries ?? 0) + 1;
  if (job.retries >= MAX_JOB_RETRIES) {
    job.status = "failed";
    job.error = "generation failed repeatedly";
    job.failureStage = "generation";
    delete job.generationLeaseUntil;
    await store.putJob(job);
    return "failed";
  }
  job.status = "paid";
  delete job.generationLeaseUntil;
  await store.putJob(job);
  return "paid";
}
