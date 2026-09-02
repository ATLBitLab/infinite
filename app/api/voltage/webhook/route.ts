import { after } from "next/server";
import { config } from "@/lib/config";
import {
  publishPaymentActivity,
  recordInvoice,
  recordPaymentCompleted,
  recordPaymentFailed,
} from "@/lib/payment-state";
import {
  parseVoltageWebhook,
  verifyVoltageWebhookSignature,
} from "@/lib/voltage-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function empty(status: number) {
  return new Response(null, { status });
}

/** Receive low-latency payment snapshots from Voltage. Keep this handler
 * smaller than Voltage's two-second delivery timeout: authenticate, persist,
 * acknowledge. Rendering and video generation remain browser-driven. */
export async function POST(request: Request) {
  const { webhookId, webhookSecret, orgId, envId, walletId } = config.voltage;
  if (!webhookId || !webhookSecret) {
    console.error("Voltage webhook received before VOLTAGE_WEBHOOK_ID/SECRET were configured");
    return empty(503);
  }

  const deliveredWebhookId = request.headers.get("x-voltage-webhook-id");
  const signature = request.headers.get("x-voltage-signature");
  const timestamp = request.headers.get("x-voltage-timestamp");
  const eventHeader = request.headers.get("x-voltage-event");
  if (
    deliveredWebhookId?.toLowerCase() !== webhookId ||
    !signature ||
    !timestamp ||
    !eventHeader
  ) {
    return empty(401);
  }

  // request.text() preserves the payload representation used to calculate the
  // signature. Never verify a parsed/re-serialized JSON object.
  const rawBody = await request.text();
  if (
    !verifyVoltageWebhookSignature({
      rawBody,
      timestamp,
      signature,
      secret: webhookSecret,
    })
  ) {
    return empty(401);
  }

  const payload = parseVoltageWebhook(rawBody);
  if (!payload || payload.detail.event !== eventHeader) return empty(400);
  if (payload.type === "test") return empty(204);

  const payment = payload.detail.data;
  // A registration is environment-wide, but reject a valid delivery if its
  // payment scope does not match the environment configured for this app.
  if (
    payment.organization_id !== orgId ||
    payment.environment_id !== envId ||
    payment.wallet_id !== walletId ||
    (payment.direction && payment.direction !== "receive") ||
    (payment.type && payment.type !== "bolt11")
  ) {
    console.warn(`Ignoring out-of-scope Voltage ${payload.detail.event} webhook`);
    return empty(204);
  }

  try {
    const bolt11 = payment.data?.payment_request;
    const ref = { jobId: payment.id, paymentId: payment.id };
    switch (payload.detail.event) {
      case "generated":
      case "refreshed":
        if (!bolt11) return empty(503);
        await recordInvoice(ref, bolt11);
        break;
      case "completed": {
        // Only the durable state transition is on Voltage's two-second
        // critical path. Invoice backfill and public activity are non-critical.
        const transitioned = await recordPaymentCompleted(ref);
        if (bolt11 || transitioned) {
          after(async () => {
            try {
              if (bolt11) await recordInvoice(ref, bolt11);
              if (transitioned) await publishPaymentActivity(ref.jobId);
            } catch (err) {
              console.error("post-payment webhook work failed:", err);
            }
          });
        }
        break;
      }
      case "expired":
      case "failed":
        await recordPaymentFailed(ref, payload.detail.event);
        break;
      // detected/succeeded are partial receipt states, not authorization to
      // generate a paid clip.
      case "detected":
      case "succeeded":
        break;
    }
  } catch (err) {
    console.error("Voltage webhook persistence failed:", err);
    return empty(503);
  }

  // Signed events for payments created by another app in this environment are
  // intentionally acknowledged; the atomic store methods simply find no job.
  return empty(204);
}
