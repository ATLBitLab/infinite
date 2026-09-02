import { randomUUID } from "crypto";
import { config, mockMode } from "./config";
import { getStore } from "./store";
import type { InvoiceInfo } from "./types";

/** Voltage Payments API (https://voltageapi.com/v1/docs).
 * Auth: x-api-key header. Amounts are in millisats for btc.
 * Create is async: POST returns 202, then poll GET until the bolt11
 * payment_request appears. Mock mode auto-settles invoices after ~5s. */

const H = () => ({
  "x-api-key": config.voltage.apiKey,
  "Content-Type": "application/json",
});

function paymentsUrl(paymentId = "") {
  const { baseUrl, orgId, envId } = config.voltage;
  return `${baseUrl}/organizations/${orgId}/environments/${envId}/payments${paymentId ? `/${paymentId}` : ""}`;
}

export async function createInvoice(
  sats: number,
  description: string,
): Promise<InvoiceInfo> {
  if (mockMode.voltage) return mockCreateInvoice(sats);

  const id = randomUUID();
  const res = await fetch(paymentsUrl(), {
    method: "POST",
    headers: H(),
    body: JSON.stringify({
      id,
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

  // Fast path: the "receive generated" webhook mirrors the bolt11 into our
  // store straight from Voltage's primary (~300ms), bypassing their lagging
  // read replica. Poll our store tightly for a few seconds first.
  const store = getStore();
  const webhookDeadline = Date.now() + 4000;
  while (Date.now() < webhookDeadline) {
    const state = await store.getPaymentState(id);
    if (state?.bolt11) {
      return { paymentId: id, bolt11: state.bolt11, sats };
    }
    if (state && (state.status === "failed" || state.status === "expired")) {
      throw new Error(`voltage payment ${state.status} before invoice generation`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  // Fallback: webhook not configured or delayed — poll their API directly.
  // Creation is async: the record 404s briefly after the 202, so 404 means
  // "not materialized yet", not an error.
  for (let i = 0; i < 16; i++) {
    const payment = await getPayment(id);
    if (payment.bolt11) {
      return { paymentId: id, bolt11: payment.bolt11, sats };
    }
    if (payment.status === "failed" || payment.status === "expired") {
      throw new Error(`voltage payment ${payment.status} before invoice generation`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("voltage invoice generation timed out");
}

export interface PaymentState {
  status: string;
  bolt11?: string;
  paid: boolean;
}

export async function getPayment(paymentId: string): Promise<PaymentState> {
  if (mockMode.voltage) return mockGetPayment(paymentId);

  // Webhook-fed state is fresher than Voltage's read replica — prefer it.
  // Reconciliation: a non-terminal state that hasn't been refreshed recently
  // could mean a lost delivery, so fall through to the replica then.
  const state = await getStore().getPaymentState(paymentId);
  const terminal =
    state && ["completed", "failed", "expired"].includes(state.status);
  if (state && (terminal || Date.now() - state.ts < 15_000)) {
    return {
      status: state.status,
      bolt11: state.bolt11,
      paid: state.status === "completed",
    };
  }

  const res = await fetch(paymentsUrl(paymentId), { headers: H() });
  // Async creation + replica lag: a payment can 404 for a moment after its
  // 202. Prefer whatever the webhook told us over a replica 404.
  if (res.status === 404) {
    if (state) {
      return {
        status: state.status,
        bolt11: state.bolt11,
        paid: state.status === "completed",
      };
    }
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

async function mockCreateInvoice(sats: number): Promise<InvoiceInfo> {
  const id = randomUUID();
  mockInvoices.set(id, Date.now());
  return {
    paymentId: id,
    bolt11: `lnbcmock${sats}n1_${id.replace(/-/g, "")}_this_is_a_mock_invoice_set_voltage_env_vars_to_go_live`,
    sats,
  };
}

async function mockGetPayment(paymentId: string): Promise<PaymentState> {
  const created = mockInvoices.get(paymentId);
  if (!created) return { status: "failed", paid: false };
  const paid = Date.now() - created > 5000;
  return { status: paid ? "completed" : "receiving", paid };
}
