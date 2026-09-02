import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findClip } from "@/lib/stream";
import ClipClient from "./clip-client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const creditLine = (kind: string, credit?: string) =>
  kind === "paid"
    ? `submitted by ${credit || "an anonymous weirdo"}`
    : "written by the house AI";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const clip = await findClip(id);
  if (!clip) return { title: "Cartoon not found — INFINITE" };
  const title = `“${clip.title}” — INFINITE`;
  const description = `${clip.idea.slice(0, 180)} · ${creditLine(clip.kind, clip.credit)} on the endless cartoon channel.`;
  return {
    title,
    description,
    openGraph: {
      type: "video.other",
      url: `/c/${clip.id}`,
      siteName: "INFINITE",
      title,
      description,
      videos: [{ url: clip.videoUrl, type: "video/mp4" }],
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ClipPage({ params }: Props) {
  const { id } = await params;
  const clip = await findClip(id);
  if (!clip) notFound();
  return <ClipClient clip={clip} credit={creditLine(clip.kind, clip.credit)} />;
}
