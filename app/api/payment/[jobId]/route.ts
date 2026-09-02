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

  return Response.json({
    jobId: job.id,
    status: job.status,
    title: job.title,
    invoice:
      job.bolt11 && job.sats
        ? { bolt11: job.bolt11, sats: job.sats }
        : null,
    clipId: job.clipId,
    error: job.error,
  });
}
