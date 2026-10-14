import { verifyNip98 } from "@/lib/nip98";
import { getStore } from "@/lib/store";
import type { JobStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const HISTORY_LIMIT = 200;
// Purchases that have not become a clip (yet). "done" jobs are the clips
// themselves; "rejected" ones never asked for money.
const IN_FLIGHT: JobStatus[] = [
  "preparing",
  "awaiting_payment",
  "paid",
  "generating",
  "failed",
];

/** The caller's own submissions, newest first. Requires a NIP-98 signed GET
 * from the browser key: there is deliberately no way to list another
 * pubkey's videos. */
export async function GET(request: Request) {
  const pubkey = verifyNip98(request);
  if (!pubkey) {
    return Response.json({ error: "signed request required" }, { status: 401 });
  }

  const store = getStore();
  const [clipIds, jobs, clips] = await Promise.all([
    store.getCreatorClipIds(pubkey, HISTORY_LIMIT),
    store.getCreatorJobs(pubkey),
    store.getClips(),
  ]);
  const byId = new Map(clips.map((c) => [c.id, c]));
  const listed = new Set(clipIds.filter((id) => byId.has(id)));

  const videos = clipIds.flatMap((id) => {
    const clip = byId.get(id);
    return clip
      ? [
          {
            id: clip.id,
            title: clip.title,
            duration: clip.duration,
            createdAt: clip.createdAt,
            airAt: clip.airAt,
            permalink: `/c/${clip.id}`,
          },
        ]
      : [];
  });

  const pending = jobs
    .filter((job) => IN_FLIGHT.includes(job.status) && !(job.clipId && listed.has(job.clipId)))
    .map((job) => ({
      jobId: job.id,
      title: job.title || job.idea.slice(0, 80),
      status: job.status,
      duration: job.duration,
      createdAt: job.createdAt,
      error: job.status === "failed" ? job.error : undefined,
    }));

  return Response.json(
    { pubkey, videos, pending },
    { headers: { "Cache-Control": "no-store" } },
  );
}
