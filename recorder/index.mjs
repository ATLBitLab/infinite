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
 * Runs anywhere with Node 20+, Chromium (npx playwright install chromium) and
 * ffmpeg on PATH. Env:
 *   INFINITE_URL       https://infinite.atlbitlab.com (no trailing slash)
 *   RECORDER_SECRET    must match the app's RECORDER_SECRET
 *   FAL_KEY            fal API key (spent by the Director session + upload)
 *   RECORDER_POLL_MS   idle poll interval (default 15000)
 *   RECORDER_FAKE=1    synthetic canvas stream instead of a fal session (tests
 *                      the whole pipeline for free; app can be in mock mode)
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

async function api(body) {
  const res = await fetch(`${APP}/api/director`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/director ${body.action} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

/** Drive the browser harness for one episode; returns the webm path. */
async function recordSession(spec) {
  await mkdir(WORK_DIR, { recursive: true });
  const webmPath = path.join(WORK_DIR, `${spec.jobId}.webm`);
  const webm = createWriteStream(webmPath);
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const events = [];
  let chunks = 0;
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
    await page.evaluate(
      ({ spec, opts }) => window.startRecording(spec, opts),
      { spec, opts: { key: FAL_KEY, fake: FAKE, mediaTimeoutMs: MEDIA_TIMEOUT_MS } },
    );
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => webm.end(r));
  }
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
  const result = await api({ action: "complete", jobId: job.jobId, videoUrl, duration });
  log(`done: clip ${result.clipId}`);
  await rm(webmPath, { force: true });
  await rm(mp4Path, { force: true });
}

async function main() {
  log(`recorder up → ${APP} (${FAKE ? "fake stream" : "H3 Max Director"})`);
  for (;;) {
    let claimed;
    try {
      claimed = await api({ action: "claim" });
    } catch (err) {
      log("claim failed:", err.message);
      if (ONCE) process.exit(1);
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    if (claimed.status !== "claimed") {
      if (ONCE) {
        log("nothing queued");
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    const job = claimed.job;
    try {
      await processJob(job);
    } catch (err) {
      log(`job ${job.jobId} failed:`, err.message);
      await api({ action: "fail", jobId: job.jobId, error: err.message }).catch((e) =>
        log("could not report failure:", e.message),
      );
      if (ONCE) process.exit(1);
    }
    if (ONCE) return;
  }
}

main().catch(die);
