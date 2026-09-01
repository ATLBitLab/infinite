import { randomUUID } from "crypto";
import { config, mockMode } from "./config";
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

  // Poll until the invoice is generated (usually <2s).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const payment = await getPayment(id);
    if (payment.bolt11) {
      return { paymentId: id, bolt11: payment.bolt11, sats };
    }
    if (payment.status === "failed" || payment.status === "expired") {
      throw new Error(`voltage payment ${payment.status} before invoice generation`);
    }
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

  const res = await fetch(paymentsUrl(paymentId), { headers: H() });
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
