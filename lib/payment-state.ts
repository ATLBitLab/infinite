import { getStore } from "./store";

/** Apply payment events through the store's monotonic operations. These are
 * shared by low-latency webhooks and the slower Payments API reconciliation. */

export interface PaymentJobRef {
  jobId: string;
  paymentId: string;
}

export async function recordInvoice(ref: PaymentJobRef, bolt11: string) {
  return getStore().setJobInvoice(ref.jobId, ref.paymentId, bolt11);
}

export async function recordPaymentCompleted(ref: PaymentJobRef) {
  return getStore().markJobPaid(ref.jobId, ref.paymentId);
}

export async function publishPaymentActivity(jobId: string) {
  const store = getStore();
  try {
    const job = await store.getJob(jobId);
    if (job) {
      await store.pushActivity({
        id: job.id,
        type: "submission",
        name: job.credit || "an anonymous weirdo",
        title: job.title,
        ts: Date.now(),
      });
    }
  } catch (err) {
    console.error("payment activity update failed:", err);
  }
}

export async function recordPaymentFailed(
  ref: PaymentJobRef,
  status: "expired" | "failed",
) {
  return getStore().markJobPaymentFailed(
    ref.jobId,
    ref.paymentId,
    `payment ${status}`,
  );
}
