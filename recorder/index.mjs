#!/usr/bin/env node
/** INFINITE recorder worker for H3 Max Director episodes.
 *
 * Director is a live WebRTC stream with no mp4 output, so this worker turns a
 * paid director job into a Clip the station can air:
 *
 *   claim job  →  headless Chromium opens the Director session and records it
 *              →  ffmpeg remuxes webm → mp4 (h264/aac, faststart)
 *              →  upload to fal storage
 *              →  report the mp4 URL back to /api/director
 *
 * Run ONE instance per station: every claim opens a billed live session and
 * the station hands each job to exactly one lease holder.
 *
 * Runs anywhere with Node 20+, Chromium (npx playwright install chromium) and
 * ffmpeg on PATH. Env:
 *   INFINITE_URL       https://infinite.atlbitlab.com (no trailing slash)
 *   RECORDER_SECRET    must match the app's RECORDER_SECRET
 *   FAL_KEY            fal API key (spent by the Director session + upload)
 *   RECORDER_POLL_MS   idle poll interval (default 15000)
 *   RECORDER_FAKE=1    synthetic canvas stream instead of a fal session (tests
 *                      the whole pipeline for free; the station must be in
 *                      mock mode — a real station refuses fake claims)
 *   RECORDER_FAKE_UPLOAD_URL  skip the fal upload and report this URL instead
 *   RECORDER_HEADED=1  show the browser window */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFalClient } from "@fal-ai/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.env.INFINITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.RECORDER_SECRET ?? "";
const FAL_KEY = process.env.FAL_KEY ?? "";
const POLL_MS = Number(process.env.RECORDER_POLL_MS ?? 15_000);
const FAKE = process.env.RECORDER_FAKE === "1";
const FAKE_UPLOAD_URL = process.env.RECORDER_FAKE_UPLOAD_URL ?? "";
const HEADED = process.env.RECORDER_HEADED === "1";
const ONCE = process.argv.includes("--once");
const MEDIA_TIMEOUT_MS = 180_000;
const API_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 10 * 60_000;
const COMPLETE_ATTEMPTS = 6;
const WORK_DIR = path.join(here, "work");

if (!SECRET) die("RECORDER_SECRET is required");
if (!FAKE && !FAL_KEY) die("FAL_KEY is required (or set RECORDER_FAKE=1)");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(body) {
  const res = await fetch(`${APP}/api/director`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`/api/director ${body.action} → ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Report the outcome with retries: by now a billed session has been
 * recorded and uploaded, and a transient 5xx must not throw that away. */
async function apiWithRetry(body) {
  let lastErr;
  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt++) {
    try {
      return await api(body);
    } catch (err) {
      lastErr = err;
      // 4xx = the station rejected it (stale lease, bad url): retrying is pointless.
      if (err.status && err.status < 500) throw err;
      log(`${body.action} attempt ${attempt} failed: ${err.message}`);
      await sleep(Math.min(60_000, 5_000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${TOOL_TIMEOUT_MS / 1000}s`));
    }, TOOL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
    });
  });
}

/** Drive the browser harness for one episode; returns the webm path. */
async function recordSession(spec) {
  await mkdir(WORK_DIR, { recursive: true });
  const webmPath = path.join(WORK_DIR, `${spec.jobId}.webm`);
  const webm = createWriteStream(webmPath);
  let writeError = null;
  webm.on("error", (e) => {
    writeError = e;
  });
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const events = [];
  let chunks = 0;
  let failed = null;
  // Hard ceiling on the whole browser step: negotiation + first frame +
  // the episode itself + teardown. A wedged page must never block the loop.
  const deadlineMs = MEDIA_TIMEOUT_MS * 2 + spec.duration * 1000 + 60_000;
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") log("browser:", m.text());
    });
    await page.exposeFunction("__recorderChunk", (b64) => {
      chunks += 1;
      webm.write(Buffer.from(b64, "base64"));
    });
    await page.exposeFunction("__recorderEvent", (json) => {
      const ev = JSON.parse(json);
      events.push(ev);
      const { type, at, ...rest } = ev;
      if (type === "failed") failed = rest;
      if (type === "server") {
        const m = rest.message ?? {};
        if (m.type === "chunk") {
          log(`  chunk ${m.chunk_index} (prompt v${m.prompt_version ?? "?"}, playback ${m.playback_seconds ?? "?"}s, buffer ${m.buffer_depth_seconds ?? "?"}s)`);
        } else if (m.type !== "chunk_metrics" && m.type !== "session_metrics" && m.type !== "pong") {
          log(`  server ${m.type}`, JSON.stringify(m).slice(0, 200));
        }
      } else {
        log(`  ${type}`, Object.keys(rest).length ? JSON.stringify(rest).slice(0, 200) : "");
      }
    });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#000">` +
        `<video playsinline style="width:640px;height:360px"></video><canvas></canvas></body></html>`,
    );
    await page.addScriptTag({ path: path.join(here, "dist", "harness.js") });
    const session = page.evaluate(
      ({ spec, opts }) => window.startRecording(spec, opts),
      { spec, opts: { key: FAL_KEY, fake: FAKE, mediaTimeoutMs: MEDIA_TIMEOUT_MS } },
    );
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`browser step exceeded ${Math.round(deadlineMs / 1000)}s`)),
        deadlineMs,
      );
    });
    try {
      await Promise.race([session, deadline]);
    } finally {
      // Otherwise the pending timer keeps the process alive after a
      // successful run and later fires as a stray rejection.
      clearTimeout(deadlineTimer);
    }
  } catch (err) {
    // Prefer the harness's own classification (code/retryable/balanceLock).
    if (failed) {
      const e = new Error(failed.error);
      Object.assign(e, failed);
      throw e;
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => webm.end(r));
  }
  if (writeError) throw writeError;
  if (chunks === 0) throw new Error("recorder produced no media");
  const recorded = events.find((e) => e.type === "recording_stopped");
  return { webmPath, recordedSeconds: recorded?.recordedSeconds ?? spec.duration };
}

async function transcode(webmPath) {
  const mp4Path = webmPath.replace(/\.webm$/, ".mp4");
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", webmPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    mp4Path,
  ]);
  const probe = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4Path,
  ]);
  const duration = Number(probe.trim());
  return { mp4Path, duration: Number.isFinite(duration) ? duration : 0 };
}

async function upload(mp4Path) {
  if (FAKE_UPLOAD_URL) return FAKE_UPLOAD_URL;
  const fal = createFalClient({ credentials: FAL_KEY });
  const bytes = await readFile(mp4Path);
  const file = new File([bytes], path.basename(mp4Path), { type: "video/mp4" });
  return fal.storage.upload(file);
}

async function processJob(job) {
  log(`claimed ${job.jobId} “${job.title}” ${job.duration}s, ${job.beats.length} beats, attempt ${job.attempt}${FAKE ? " (FAKE)" : ""}`);
  const started = Date.now();
  const { webmPath, recordedSeconds } = await recordSession(job);
  const size = (await stat(webmPath)).size;
  log(`recorded ${recordedSeconds.toFixed(1)}s (${(size / 1e6).toFixed(1)} MB webm) in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const { mp4Path, duration } = await transcode(webmPath);
  log(`transcoded → ${path.basename(mp4Path)} (${duration.toFixed(1)}s)`);
  const videoUrl = await upload(mp4Path);
  log(`uploaded → ${videoUrl}`);
  const result = await apiWithRetry({
    action: "complete",
    jobId: job.jobId,
    lease: job.lease,
    videoUrl,
    duration,
  });
  log(`done: clip ${result.clipId}`);
  await rm(webmPath, { force: true });
  await rm(mp4Path, { force: true });
}

async function reportFailure(job, err) {
  const body = {
    action: "fail",
    jobId: job.jobId,
    lease: job.lease,
    error: err.message,
    code: err.code,
    retryable: err.retryable,
    balanceLock: err.balanceLock,
  };
  try {
    const res = await apiWithRetry(body);
    log(`reported failure → job ${res.status}`);
  } catch (e) {
    log("could not report failure:", e.message);
  }
}

let current = null;

// A crash mid-episode must still hand the job back, or the station waits the
// full lease before anyone else can try.
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, async (err) => {
    log(`${signal}:`, err?.stack ?? err);
    if (current) await reportFailure(current, err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  });
}

async function main() {
  log(`recorder up → ${APP} (${FAKE ? "fake stream" : "H3 Max Director"})`);
  for (;;) {
    let claimed;
    try {
      claimed = await api({
        action: "claim",
        mode: FAKE ? "fake" : "director",
        keepAlive: !ONCE,
      });
    } catch (err) {
      log("claim failed:", err.message);
      if (ONCE) process.exit(1);
      await sleep(POLL_MS);
      continue;
    }
    if (claimed.status !== "claimed") {
      if (ONCE) {
        log("nothing queued");
        return;
      }
      await sleep(POLL_MS);
      continue;
    }
    const job = claimed.job;
    current = job;
    try {
      await processJob(job);
    } catch (err) {
      log(`job ${job.jobId} failed:`, err.message);
      await reportFailure(job, err);
      if (ONCE) process.exit(1);
    } finally {
      current = null;
    }
    if (ONCE) return;
  }
}

main().then(
  () => process.exit(0),
  (err) => die(err?.stack ?? String(err)),
);
