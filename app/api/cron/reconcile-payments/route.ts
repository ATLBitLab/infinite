import { getPayment } from "@/lib/voltage";
import {
  publishPaymentActivity,
  recordInvoice,
  recordPaymentCompleted,
  recordPaymentFailed,
  type PaymentJobRef,
} from "@/lib/payment-state";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import {
  MAX_INVOICE_REQUEST_ATTEMPTS,
  prepareSubmission,
  requestPreparedInvoice,
  type PreparationOutcome,
} from "@/lib/submission-preflight";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Longer than this route's configured lifetime so a normal run cannot expire
// its lock and overlap the next once-per-minute invocation.
const RECONCILIATION_LOCK_SECONDS = 70;
const MAX_JOBS_PER_RUN = 25;
const CONCURRENCY = 5;
const PAYMENT_READ_TIMEOUT_MS = 5_000;

type Outcome =
  | "completed"
  | "failed"
  | "invoice"
  | "requested"
  | "pending"
  | "error";

/** Scheduled recovery for missed webhooks and interrupted writers' room work.
 * Payment reads remain isolated from the browser-facing payment route. */
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

  const store = getStore();
  const locked = await store.acquireLock(
    "payment-reconciliation",
    RECONCILIATION_LOCK_SECONDS,
  );
  if (!locked) {
    return Response.json({ status: "already_running" }, { status: 202 });
  }

  try {
    // Start one stale preflight beside payment reads. Running them in series
    // could exceed this route's shared 60-second duration.
    const [preparation, paymentResult] = await Promise.all([
      reconcileOnePreparation(),
      reconcilePendingPayments(),
    ]);
    const { jobs, outcomes } = paymentResult;

    const counts = Object.fromEntries(
      (["completed", "failed", "invoice", "requested", "pending", "error"] as Outcome[])
        .map((outcome) => [
          outcome,
          outcomes.filter((value) => value === outcome).length,
        ]),
    );
    return Response.json({
      status: "ok",
      preparation,
      checked: jobs.length,
      ...counts,
    });
  } finally {
    await store.releaseLock("payment-reconciliation");
  }
}

async function reconcileOnePreparation(): Promise<PreparationOutcome | "none"> {
  const [job] = await getStore().claimPreparingJobs(1);
  return job ? prepareSubmission(job.id) : "none";
}

async function reconcilePendingPayments() {
  const jobs = await getStore().claimPendingPaymentJobs(MAX_JOBS_PER_RUN);
  const outcomes: Outcome[] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    outcomes.push(
      ...(await Promise.all(
        jobs.slice(i, i + CONCURRENCY).map(reconcilePayment),
      )),
    );
  }
  return { jobs, outcomes };
}

async function reconcilePayment(job: Job): Promise<Outcome> {
  if (!job.paymentId) return "pending";
  const ref: PaymentJobRef = { jobId: job.id, paymentId: job.paymentId };
  try {
    const payment = await getPayment(
      job.paymentId,
      AbortSignal.timeout(PAYMENT_READ_TIMEOUT_MS),
    );
    if (payment.status === "not_found") {
      if (job.bolt11) return "pending";
      const request = await requestPreparedInvoice(job.id, true);
      if (
        request === "skipped" &&
        (job.invoiceRequestAttempts ?? 0) >= MAX_INVOICE_REQUEST_ATTEMPTS &&
        job.failureStage !== "invoice"
      ) {
        await getStore().setJobError(
          job.id,
          "awaiting_payment",
          "invoice",
          "Lightning checkout is temporarily unavailable. We will keep checking.",
        );
      }
      return request === "requested"
        ? "requested"
        : request === "delayed"
          ? "error"
          : "pending";
    }
    const recordedInvoice = payment.bolt11
      ? await recordInvoice(ref, payment.bolt11)
      : false;

    // Any non-404 read proves the async payment exists, even if invoice
    // generation is still underway and no BOLT11 is present yet.
    await getStore().clearJobError(job.id, "awaiting_payment", "invoice");

    if (payment.paid) {
      const transitioned = await recordPaymentCompleted(ref);
      if (transitioned) await publishPaymentActivity(job.id);
      return "completed";
    }
    if (payment.status === "expired" || payment.status === "failed") {
      await recordPaymentFailed(ref, payment.status);
      return "failed";
    }
    return recordedInvoice ? "invoice" : "pending";
  } catch (err) {
    console.error(`payment reconciliation failed for ${job.id}:`, err);
    return "error";
  }
}
