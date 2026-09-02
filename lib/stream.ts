import { getStore } from "./store";
import { config } from "./config";
import type { Clip, NowPlaying } from "./types";

/** "Synthetic live" scheduling.
 *
 * Fresh clips get an `airAt` slot (appended after the last scheduled clip, or
 * now). When nothing is scheduled at the current moment, the stream falls back
 * to a deterministic rerun loop over the whole library keyed to wall-clock
 * time — so every viewer computes the same clip and offset without any
 * streaming server. */

export async function scheduleClip(
  clip: Omit<Clip, "airAt">,
): Promise<Clip> {
  const store = getStore();
  const clips = await store.getClips();
  const now = Date.now();
  const lastAirEnd = clips.reduce(
    (max, c) => Math.max(max, c.airAt + c.duration * 1000),
    0,
  );
  const scheduled: Clip = { ...clip, airAt: Math.max(now, lastAirEnd) };
  await store.addClip(scheduled);
  return scheduled;
}

export async function nowPlaying(): Promise<NowPlaying> {
  const store = getStore();
  const clips = await store.getClips();
  const now = Date.now();

  // Viewer-triggered house generation fires when the library is thin OR the
  // newest clip has gone stale (keeps the channel fresh without a cron —
  // no viewers, no polls, no spend). Budget caps enforced in /api/generate.
  const newestCreatedAt = clips.reduce((max, c) => Math.max(max, c.createdAt), 0);
  const stale =
    config.houseFreshHours > 0 &&
    now - newestCreatedAt > config.houseFreshHours * 3_600_000;

  const empty: NowPlaying = {
    clip: null,
    offsetMs: 0,
    rerun: false,
    upNext: [],
    serverNow: now,
    libraryCount: clips.length,
    needsBootstrap: clips.length < config.minLibraryClips || stale,
  };
  if (clips.length === 0) return empty;

  const upNext = clips
    .filter((c) => c.airAt > now)
    .sort((a, b) => a.airAt - b.airAt)
    .slice(0, 5)
    .map((c) => ({ id: c.id, title: c.title, credit: c.credit, kind: c.kind }));

  // 1. A freshly scheduled clip airing right now wins.
  const live = clips.find(
    (c) => c.airAt <= now && now < c.airAt + c.duration * 1000,
  );
  if (live) {
    return {
      ...empty,
      clip: live,
      offsetMs: now - live.airAt,
      upNext,
    };
  }

  // 2. Otherwise: deterministic rerun loop over the library, ordered by
  // creation time, positioned by wall clock. Same answer for every viewer.
  const ordered = [...clips].sort((a, b) => a.createdAt - b.createdAt);
  const totalMs = ordered.reduce((sum, c) => sum + c.duration * 1000, 0);
  let position = now % totalMs;
  for (const clip of ordered) {
    const len = clip.duration * 1000;
    if (position < len) {
      return { ...empty, clip, offsetMs: position, rerun: true, upNext };
    }
    position -= len;
  }
  // Unreachable, but keep the type-checker honest.
  return empty;
}
