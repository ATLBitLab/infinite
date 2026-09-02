import { createHmac, timingSafeEqual } from "crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const VOLTAGE_WEBHOOK_MAX_AGE_SECONDS = 300;

export type VoltageReceiveEvent =
  | "generated"
  | "refreshed"
  | "detected"
  | "succeeded"
  | "completed"
  | "expired"
  | "failed";

export interface VoltageReceiveWebhook {
  type: "receive";
  detail: {
    event: VoltageReceiveEvent;
    data: {
      id: string;
      organization_id: string;
      environment_id: string;
      wallet_id: string;
      direction?: string;
      type?: string;
      status?: string;
      data?: { payment_request?: string | null };
    };
  };
}

export interface VoltageTestWebhook {
  type: "test";
  detail: { event: "created"; data: unknown };
}

export type VoltageWebhook = VoltageReceiveWebhook | VoltageTestWebhook;

/** Verify the exact bytes Voltage sent before parsing JSON. The signature is
 * padded Base64(HMAC-SHA256(secret, rawBody + "." + timestamp)). */
export function verifyVoltageWebhookSignature({
  rawBody,
  timestamp,
  signature,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  rawBody: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowSeconds?: number;
}): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt)) return false;
  if (Math.abs(nowSeconds - sentAt) > VOLTAGE_WEBHOOK_MAX_AGE_SECONDS) return false;
  // A SHA-256 digest is exactly 44 characters in canonical padded Base64.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;

  const expected = createHmac("sha256", secret)
    .update(`${rawBody}.${timestamp}`, "utf8")
    .digest();
  const actual = Buffer.from(signature, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RECEIVE_EVENTS = new Set<VoltageReceiveEvent>([
  "generated",
  "refreshed",
  "detected",
  "succeeded",
  "completed",
  "expired",
  "failed",
]);

/** Parse the small portion of the full payment snapshot this app consumes. */
export function parseVoltageWebhook(rawBody: string): VoltageWebhook | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.detail)) return null;

  const event = value.detail.event;
  if (value.type === "test") {
    return event === "created"
      ? { type: "test", detail: { event, data: value.detail.data } }
      : null;
  }

  const payment = value.detail.data;
  if (
    value.type !== "receive" ||
    typeof event !== "string" ||
    !RECEIVE_EVENTS.has(event as VoltageReceiveEvent) ||
    !isRecord(payment) ||
    typeof payment.id !== "string" ||
    !UUID.test(payment.id) ||
    typeof payment.organization_id !== "string" ||
    typeof payment.environment_id !== "string" ||
    typeof payment.wallet_id !== "string"
  ) {
    return null;
  }

  const paymentData = isRecord(payment.data) ? payment.data : undefined;
  const paymentRequest = paymentData?.payment_request;
  if (paymentRequest !== undefined && paymentRequest !== null && typeof paymentRequest !== "string") {
    return null;
  }

  return {
    type: "receive",
    detail: {
      event: event as VoltageReceiveEvent,
      data: {
        id: payment.id,
        organization_id: payment.organization_id,
        environment_id: payment.environment_id,
        wallet_id: payment.wallet_id,
        direction: typeof payment.direction === "string" ? payment.direction : undefined,
        type: typeof payment.type === "string" ? payment.type : undefined,
        status: typeof payment.status === "string" ? payment.status : undefined,
        data: paymentData ? { payment_request: paymentRequest as string | null | undefined } : undefined,
      },
    },
  };
}
