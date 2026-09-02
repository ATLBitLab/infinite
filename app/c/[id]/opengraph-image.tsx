import { OG_SIZE, headlineSizeFor, renderOgCard } from "../../og/card";
import { findClip } from "@/lib/stream";

export const dynamic = "force-dynamic";
export const alt = "A cartoon from INFINITE, the endless cartoon channel";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const clip = await findClip(id);
  if (!clip) {
    return renderOgCard({
      headline: "LOST SIGNAL",
      headlineSize: 120,
      tagline: "THAT CARTOON ISN'T IN THE LIBRARY",
      blurb: "The live channel never stops, though. Tune in for a fresh one.",
    });
  }
  const credit =
    clip.kind === "paid"
      ? `SUBMITTED BY ${(clip.credit || "AN ANONYMOUS WEIRDO").toUpperCase()}`
      : "WRITTEN BY THE HOUSE AI";
  return renderOgCard({
    kicker: "NOW SHOWING ON INFINITE",
    headline: clip.title,
    headlineSize: headlineSizeFor(clip.title),
    tagline: credit.slice(0, 40),
    blurb: clip.idea.length > 150 ? clip.idea.slice(0, 147).trimEnd() + "…" : clip.idea,
  });
}
