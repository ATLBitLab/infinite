import { nowPlaying } from "@/lib/stream";
import { submissionPriceSats } from "@/lib/price";
import { mockMode } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const [now, priceSats] = await Promise.all([
    nowPlaying(),
    submissionPriceSats(),
  ]);
  return Response.json({ ...now, priceSats, mockMode });
}
