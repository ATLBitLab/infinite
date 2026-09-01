import { randomUUID } from "crypto";
import { moderateAndExpand } from "@/lib/llm";
import { createInvoice } from "@/lib/voltage";
import { submissionPriceSats } from "@/lib/price";
import { getStore } from "@/lib/store";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Submit an idea: moderate it, and if it passes, hand back a Lightning
 * invoice + job id. Payment is checked in /api/payment/[jobId]. */
export async function POST(request: Request) {
  let body: { idea?: string; credit?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const idea = (body.idea ?? "").trim().slice(0, 500);
  const credit = (body.credit ?? "").trim().slice(0, 50) || undefined;
  if (idea.length < 5) {
    return Response.json({ error: "Give us a little more than that." }, { status: 400 });
  }

  try {
    const moderation = await moderateAndExpand(idea);
    if (!moderation.allowed) {
      return Response.json({ rejected: true, reason: moderation.reason }, { status: 200 });
    }

    const sats = await submissionPriceSats();
    const jobId = randomUUID();
    const invoice = await createInvoice(sats, `INFINITE: ${moderation.title}`.slice(0, 90));

    const job: Job = {
      id: jobId,
      status: "awaiting_payment",
      idea,
      title: moderation.title,
      videoPrompt: moderation.videoPrompt,
      credit,
      paymentId: invoice.paymentId,
      createdAt: Date.now(),
    };
    await getStore().putJob(job);

    return Response.json({
      jobId,
      title: moderation.title,
      reason: moderation.reason,
      invoice: { bolt11: invoice.bolt11, sats: invoice.sats },
    });
  } catch (err) {
    console.error("submit failed:", err);
    return Response.json({ error: "Something broke backstage. Try again." }, { status: 500 });
  }
}
