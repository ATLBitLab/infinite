import { createHmac, timingSafeEqual } from "crypto";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Voltage webhook receiver (https://docs.voltageapi.com/webhooks).
 *
 * Voltage's GET /payments reads a lagging replica, which made QR generation
 * slow. Webhooks deliver payment state straight from the primary; we verify
 * the signature and mirror the state into our own store, which createInvoice
 * and the payment-status route read first.
 *
 * Signature: base64(HMAC-SHA256(secret, `${rawBody} ${timestamp}`)) in
 * x-voltage-signature, timestamp in x-voltage-timestamp. */

const MAX_SKEW_MS = 5 * 60_000;

interface VoltagePayload {
  type: "send" | "receive" | "test";
  detail?: {
    event?: string;
    data?: {
      id?: string;
      status?: string;
      data?: { payment_request?: string };
    };
  };
}

function verifySignature(rawBody: string, signature: string, timestamp: string): boolean {
  const secret = process.env.VOLTAGE_WEBHOOK_SECRET ?? "";
  if (!secret) return false;
  const expected = createHmac("sha256", secret)
    .update(`${rawBody} ${timestamp}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function POST(request: Request) {
  if (!process.env.VOLTAGE_WEBHOOK_SECRET) {
    return Response.json({ error: "webhook secret not configured" }, { status: 503 });
  }

  const signature = request.headers.get("x-voltage-signature") ?? "";
  const timestamp = request.headers.get("x-voltage-timestamp") ?? "";
  const rawBody = await request.text();

  if (!signature || !timestamp || !verifySignature(rawBody, signature, timestamp)) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const tsMs = Number(timestamp) * (timestamp.length > 11 ? 1 : 1000);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    return Response.json({ error: "stale timestamp" }, { status: 401 });
  }

  let payload: VoltagePayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  if (payload.type === "receive" && payload.detail?.data?.id) {
    const payment = payload.detail.data;
    await getStore().putPaymentState(payment.id!, {
      status: payment.status ?? "unknown",
      bolt11: payment.data?.payment_request,
      event: payload.detail.event ?? "unknown",
      ts: Date.now(),
    });
  }
  // Acknowledge everything (including test events) quickly.
  return Response.json({ ok: true });
}
