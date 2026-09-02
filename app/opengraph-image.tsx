import { OG_SIZE, renderOgCard } from "./og/card";

export const alt =
  "INFINITE — the endless cartoon channel. AI cartoons roasting bitcoin, freedom tech, and AI. Pay sats, get on the air.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderOgCard({
    headline: "INFINITE",
    headlineSize: 160,
    tagline: "THE ENDLESS CARTOON CHANNEL",
    blurb:
      "AI cartoons roasting bitcoin, freedom tech, and AI, 24/7. Pay sats, get your idea on the air.",
  });
}
