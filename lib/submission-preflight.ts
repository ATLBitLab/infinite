import { moderateAndExpand } from "./llm";
import { submissionPriceSats } from "./price";
import { getStore } from "./store";
import type { Job } from "./types";
import { createInvoice } from "./voltage";

const PREFLIGHT_LOCK_SECONDS = 70;
const PREFLIGHT_TIMEOUT_MS = 45_000;
const MAX_PREFLIGHT_ATTEMPTS = 3;
const INVOICE_REQUEST_TIMEOUT_MS = 5_000;
const INVOICE_RETRY_INTERVAL_MS = 30_000;
export const MAX_INVOICE_REQUEST_ATTEMPTS = 3;

export type PreparationOutcome =
  | "prepared"
  | "rejected"
  | "retrying"
  | "failed"
  | "invoice_delayed"
  | "busy"
  | "missing"
  | "already_processed";

export type InvoiceRequestOutcome = "requested" | "delayed" | "skipped";

/** Reserve and perform one bounded POST for a fully prepared job. Retries use
 * the exact same server-generated payment ID and immutable request body. */
export async function requestPreparedInvoice(
  jobId: string,
  retry = false,
): Promise<InvoiceRequestOutcome> {
  const store = getStore();
  const job = await store.claimInvoiceRequest(
    jobId,
    retry ? INVOICE_RETRY_INTERVAL_MS : 0,
    MAX_INVOICE_REQUEST_ATTEMPTS,
  );
  if (!job?.paymentId || !job.sats || !job.title) return "skipped";

  try {
    const immediateBolt11 = await createInvoice(
      job.paymentId,
      job.sats,
      `INFINITE: ${job.title}`.slice(0, 90),
      {
        allowExisting: retry,
        signal: AbortSignal.timeout(INVOICE_REQUEST_TIMEOUT_MS),
      },
    );
    if (immediateBolt11) {
      await store.setJobInvoice(job.id, job.paymentId, immediateBolt11);
    } else {
      // A 202 or an idempotent 409 proves the payment write is in flight (or
      // already exists), even if its read projection has not caught up yet.
      await store.clearJobError(job.id, "awaiting_payment", "invoice");
    }
    return "requested";
  } catch (err) {
    // Do not whole-write here: a generated webhook can race the POST.
    console.error(`invoice creation delayed for job ${job.id}:`, err);
    await store.setJobError(
      job.id,
      "awaiting_payment",
      "invoice",
      "Lightning checkout is taking longer than expected.",
    );
    return "delayed";
  }
}

/** Run the slow writers' room outside the submit response. The persisted
 * preparing state lets the scheduled reconciler safely retry interrupted work. */
export async function prepareSubmission(
  jobId: string,
): Promise<PreparationOutcome> {
  const store = getStore();
  const lockKey = `submission-preflight:${jobId}`;
  if (!(await store.acquireLock(lockKey, PREFLIGHT_LOCK_SECONDS))) return "busy";

  try {
    const job = await store.getJob(jobId);
    if (!job) return "missing";
    if (job.status !== "preparing") return "already_processed";

    const attempt = (job.preflightAttempts ?? 0) + 1;
    const inProgress: Job = {
      ...job,
      preflightAttempts: attempt,
      error: undefined,
      failureStage: undefined,
    };
    await store.putJob(inProgress);

    try {
      const segments = inProgress.segmentDurations ?? [];
      if (segments.length === 0) throw new Error("submission has no render segments");

      const [moderation, sats] = await Promise.all([
        moderateAndExpand(
          inProgress.idea,
          segments,
          AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        ),
        submissionPriceSats(inProgress.duration),
      ]);

      if (!moderation.allowed) {
        await store.putJob({
          ...inProgress,
          status: "rejected",
          moderationReason:
            moderation.reason || "Standards & Practices could not approve that pitch.",
          error: undefined,
          failureStage: undefined,
        });
        return "rejected";
      }

      const title = moderation.title.trim();
      const videoPrompt = moderation.videoPrompt.trim();
      const scenePrompts = moderation.scenePrompts.map((prompt) => prompt.trim());
      if (
        !title ||
        !videoPrompt ||
        scenePrompts.length !== segments.length ||
        scenePrompts.some((prompt) => !prompt)
      ) {
        throw new Error("writers' room returned incomplete prompt data");
      }

      // This atomic checkpoint is the payment gate. Voltage is not contacted
      // until every prompt needed to render the purchased clip is durable.
      const prepared: Job = {
        ...inProgress,
        status: "awaiting_payment",
        title,
        videoPrompt,
        scenePrompts,
        sats,
        paymentId: jobId,
        preparedAt: Date.now(),
        moderationReason: moderation.reason,
        error: undefined,
        failureStage: undefined,
      };
      if (!(await store.completeJobPreparation(prepared))) {
        return "already_processed";
      }

      const invoice = await requestPreparedInvoice(jobId);
      return invoice === "delayed" ? "invoice_delayed" : "prepared";
    } catch (err) {
      console.error(`submission preflight failed for job ${jobId}:`, err);
      const current = await store.getJob(jobId);
      if (!current || current.status !== "preparing") {
        return "already_processed";
      }
      const terminal = attempt >= MAX_PREFLIGHT_ATTEMPTS;
      await store.putJob({
        ...current,
        status: terminal ? "failed" : "preparing",
        preflightAttempts: attempt,
        error: terminal
          ? "The writers' room could not prepare this submission. Try again."
          : "The writers' room hit a snag and will retry.",
        failureStage: "preflight",
      });
      return terminal ? "failed" : "retrying";
    }
  } catch (err) {
    // Storage failures leave the indexed job untouched for the next cron run.
    console.error(`submission preparation crashed for job ${jobId}:`, err);
    return "retrying";
  } finally {
    await store.releaseLock(lockKey);
  }
}
