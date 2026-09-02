import { config, mockMode } from "./config";
import {
  publishPaymentActivity,
  recordPaymentCompleted,
} from "./payment-state";

/** Voltage Payments API (https://voltageapi.com/v1/docs).
 * Auth: x-api-key header. Amounts are in millisats for btc.
 * Create is async: POST returns 202 and receive.generated delivers the
 * BOLT11 to our webhook. A scheduled worker uses GET only for reconciliation.
 * Mock mode returns the invoice inline and auto-settles after ~5s. */

const H = () => ({
  "x-api-key": config.voltage.apiKey,
  "Content-Type": "application/json",
});

function paymentsUrl(paymentId = "") {
  const { baseUrl, orgId, envId } = config.voltage;
  return `${baseUrl}/organizations/${orgId}/environments/${envId}/payments${paymentId ? `/${paymentId}` : ""}`;
}

export async function createInvoice(
  paymentId: string,
  sats: number,
  description: string,
): Promise<string | undefined> {
  if (mockMode.voltage) return mockCreateInvoice(paymentId, sats);

  const res = await fetch(paymentsUrl(), {
    method: "POST",
    headers: H(),
    body: JSON.stringify({
      id: paymentId,
      wallet_id: config.voltage.walletId,
      payment_kind: "bolt11",
      // btc amounts are denominated in millisats
      amount: { amount: sats * 1000, currency: "btc" },
      description: description.slice(0, 200),
      expiration: 3600,
    }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`voltage create payment failed: ${res.status} ${await res.text()}`);
  }
  // Live invoice data arrives through receive.generated. The client polls our
  // Redis-backed job endpoint while a scheduled worker reconciles missed
  // webhook deliveries out of band.
  return undefined;
}

export interface PaymentState {
  status: string;
  bolt11?: string;
  paid: boolean;
}

export async function getPayment(
  paymentId: string,
  signal?: AbortSignal,
): Promise<PaymentState> {
  if (mockMode.voltage) return mockGetPayment(paymentId);

  const res = await fetch(paymentsUrl(paymentId), { headers: H(), signal });
  // Async creation: a payment can 404 for a moment after its 202.
  if (res.status === 404) {
    return { status: "not_found", paid: false };
  }
  if (!res.ok) {
    throw new Error(`voltage get payment failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    status?: string;
    data?: { payment_request?: string };
  };
  const status = body.status ?? "unknown";
  return {
    status,
    bolt11: body.data?.payment_request,
    paid: status === "completed",
  };
}

// ---------- mock fallback ----------

const mockInvoices = (globalThis as unknown as {
  __mockInvoices?: Map<string, number>;
}).__mockInvoices ??= new Map<string, number>();

async function mockCreateInvoice(paymentId: string, sats: number): Promise<string> {
  mockInvoices.set(paymentId, Date.now());
  const timer = setTimeout(async () => {
    try {
      const transitioned = await recordPaymentCompleted({
        jobId: paymentId,
        paymentId,
      });
      if (transitioned) await publishPaymentActivity(paymentId);
    } catch (err) {
      console.error("mock payment settlement failed:", err);
    }
  }, 5_000);
  timer.unref();
  return `lnbcmock${sats}n1_${paymentId.replace(/-/g, "")}_this_is_a_mock_invoice_set_voltage_env_vars_to_go_live`;
}

async function mockGetPayment(paymentId: string): Promise<PaymentState> {
  const created = mockInvoices.get(paymentId);
  if (!created) return { status: "failed", paid: false };
  const paid = Date.now() - created > 5000;
  return { status: paid ? "completed" : "receiving", paid };
}
