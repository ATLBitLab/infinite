import { directorAvailable } from "@/lib/generation";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Return webhook-maintained payment state from Redis. This endpoint never
 * waits on Voltage; a scheduled reconciliation job repairs missed events. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const store = getStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });

  // A stored invoice is not browser-visible until the full render prompt has
  // passed moderation and the job has crossed the payment gate.
  const invoiceReady =
    job.status === "awaiting_payment" &&
    Boolean(job.paymentId && job.title && job.videoPrompt && job.sats && job.bolt11);
  // A director episode's invoice stays hidden while no recorder is polling:
  // the recorder may have gone away between submit and checkout, and a paid
  // job with nobody to record it would sit in the queue indefinitely.
  const directorPaused =
    invoiceReady && job.renderer === "director" && !(await directorAvailable());

  return Response.json({
    jobId: job.id,
    status: job.status,
    title: job.title || undefined,
    reason: job.moderationReason,
    sats: job.sats,
    invoice:
      invoiceReady && !directorPaused
        ? { bolt11: job.bolt11, sats: job.sats }
        : null,
    clipId: job.clipId,
    renderer: job.renderer ?? "fal",
    error: directorPaused
      ? "The director is off set — checkout is paused until the recorder is back."
      : job.error,
    failureStage: directorPaused ? "invoice" : job.failureStage,
  });
}
