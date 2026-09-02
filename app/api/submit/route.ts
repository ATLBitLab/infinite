import { randomUUID } from "crypto";
import { moderateAndExpand } from "@/lib/llm";
import { createInvoice } from "@/lib/voltage";
import { clampDuration, submissionPriceSats } from "@/lib/price";
import { getStore, persistenceMisconfigured } from "@/lib/store";
import { FAL_LOCK_FLAG } from "@/lib/fal";
import { config } from "@/lib/config";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Submit an idea, moderate it, and request a Lightning invoice. Live invoice
 * data arrives asynchronously through the Voltage webhook; mock mode can hand
 * it back inline. Payment state is exposed by /api/payment/[jobId]. */
export async function POST(request: Request) {
  // Never take someone's sats for a job a non-persistent store would forget.
  if (persistenceMisconfigured()) {
    return Response.json(
      { error: "The station is misconfigured (no Redis). Submissions are paused." },
      { status: 503 },
    );
  }
  // Never take someone's sats while the render farm is balance-locked.
  const store = getStore();
  if (await store.getFlag(FAL_LOCK_FLAG)) {
    return Response.json(
      { error: "The render farm is refueling — submissions are paused for a few minutes. Your sats are safe in your wallet where they belong." },
      { status: 503 },
    );
  }
  let body: { idea?: string; credit?: string; duration?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const idea = (body.idea ?? "").trim().slice(0, 500);
  const credit = (body.credit ?? "").trim().slice(0, 50) || undefined;
  // Server-side clamp: the client's slider is presentation only.
  const duration = clampDuration(body.duration ?? config.clipDuration);
  if (idea.length < 5) {
    return Response.json({ error: "Give us a little more than that." }, { status: 400 });
  }

  try {
    const moderation = await moderateAndExpand(idea, duration);
    if (!moderation.allowed) {
      return Response.json({ rejected: true, reason: moderation.reason }, { status: 200 });
    }

    const sats = await submissionPriceSats(duration);
    const jobId = randomUUID();
    // Use one UUID for both records so detail.data.id from a webhook resolves
    // directly to this job. Persist before the create request: generated can
    // be delivered before this HTTP handler returns.
    const job: Job = {
      id: jobId,
      status: "awaiting_payment",
      idea,
      title: moderation.title,
      videoPrompt: moderation.videoPrompt,
      credit,
      paymentId: jobId,
      sats,
      duration,
      createdAt: Date.now(),
    };
    await store.putJob(job);

    const immediateBolt11 = await createInvoice(
      jobId,
      sats,
      `INFINITE: ${moderation.title}`.slice(0, 90),
    );
    if (immediateBolt11) {
      await store.setJobInvoice(jobId, jobId, immediateBolt11);
    }

    // The webhook may have won the race with the create response. Include its
    // invoice when available; otherwise the browser begins polling our store.
    const current = await store.getJob(jobId);
    const bolt11 = current?.bolt11;

    return Response.json(
      {
        jobId,
        title: moderation.title,
        reason: moderation.reason,
        sats,
        invoice: bolt11 ? { bolt11, sats } : null,
      },
      { status: bolt11 ? 200 : 202 },
    );
  } catch (err) {
    console.error("submit failed:", err);
    return Response.json({ error: "Something broke backstage. Try again." }, { status: 500 });
  }
}
