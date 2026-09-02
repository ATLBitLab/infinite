import { fal } from "@fal-ai/client";
import { config, mockMode } from "./config";

/** Video generation via fal.ai MiniMax H3 Max.
 * ~$0.05/sec at 480P, ~$0.08/sec at 768P → a 15s/768P clip ≈ $1.20.
 * Mock mode (no FAL_KEY) returns sample videos so the whole app runs free. */

export interface GeneratedVideo {
  url: string;
  duration: number;
}

/** Store flag key: set when fal reports a balance lock, so submissions pause
 * instead of taking sats for clips that can't render. */
export const FAL_LOCK_FLAG = "fal-locked";
export const FAL_LOCK_TTL = 10 * 60; // seconds

/** fal 403s with "User is locked. Reason: Exhausted balance." when the
 * account runs dry. Detect it so we can pause paid submissions. */
export function isBalanceLock(err: unknown): boolean {
  const e = err as { status?: number; body?: { detail?: unknown } };
  const detail = typeof e?.body?.detail === "string" ? e.body.detail : "";
  return e?.status === 403 && /locked|balance/i.test(detail);
}

/** Human-readable description of a fal error, for ops surfaces. */
export function falErrorDetail(err: unknown): string {
  const e = err as { status?: number; body?: { detail?: unknown }; message?: string };
  const detail = typeof e?.body?.detail === "string" ? e.body.detail : "";
  return `${e?.status ?? ""} ${detail || e?.message || String(err)}`.trim().slice(0, 300);
}

let configured = false;
function ensureConfigured() {
  if (!configured) {
    fal.config({ credentials: config.falKey });
    configured = true;
  }
}

export async function generateVideo(prompt: string): Promise<GeneratedVideo> {
  if (mockMode.fal) return mockVideo();

  ensureConfigured();
  const result = await fal.subscribe(config.falModel, {
    input: {
      prompt,
      duration: config.clipDuration,
      resolution: config.clipResolution,
      aspect_ratio: "16:9",
      prompt_expansion_mode: "balanced",
    },
    logs: false,
  });

  const data = result.data as { video?: { url?: string } };
  if (!data?.video?.url) {
    throw new Error("fal returned no video url");
  }
  return { url: data.video.url, duration: config.clipDuration };
}

// ---------- mock fallback ----------

const SAMPLE_VIDEOS = [
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
  "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4",
  "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4",
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
];

async function mockVideo(): Promise<GeneratedVideo> {
  // Simulate ~9s generation latency like the real model.
  await new Promise((r) => setTimeout(r, 3000));
  const url = SAMPLE_VIDEOS[Math.floor(Math.random() * SAMPLE_VIDEOS.length)];
  return { url, duration: 10 };
}
