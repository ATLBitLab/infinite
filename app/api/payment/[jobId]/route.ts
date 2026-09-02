import { getPayment } from "@/lib/voltage";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Poll payment status for a job. Marks the job paid when the invoice
 * settles; the client then triggers POST /api/generate. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const store = getStore();
  const job = await store.getJob(jobId);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });

  if (job.status === "awaiting_payment" && job.paymentId) {
    try {
      const payment = await getPayment(job.paymentId);
      if (payment.paid) {
        job.status = "paid";
        await store.putJob(job);
        // Feed the live activity toasts (fire-and-forget).
        await store.pushActivity({
          id: job.id,
          type: "submission",
          name: job.credit || "an anonymous weirdo",
          title: job.title,
          ts: Date.now(),
        });
      } else if (payment.status === "expired" || payment.status === "failed") {
        job.status = "failed";
        job.error = `payment ${payment.status}`;
        await store.putJob(job);
      }
    } catch (err) {
      console.error("payment check failed:", err);
    }
  }

  return Response.json({
    jobId: job.id,
    status: job.status,
    title: job.title,
    clipId: job.clipId,
    error: job.error,
  });
}
