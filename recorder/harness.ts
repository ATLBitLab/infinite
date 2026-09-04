/** Browser side of the recorder. Bundled by esbuild into dist/harness.js and
 * injected into a headless Chromium page by index.mjs.
 *
 * Opens an H3 Max Director session over WebRTC (fal's WMA transport), feeds
 * the episode's beats to the director as each generated chunk lands, and
 * records the incoming media with MediaRecorder. Recorded webm bytes and
 * progress events are streamed back to Node through two exposed functions.
 *
 * Contract source: fal.ai/models/minimax/h3-max/director/api (AsyncAPI):
 *   client → configure { protocol_version: 1, type, prompt, prompt_version,
 *                        aspect_ratio 16:9|9:16|1:1, resolution 480p|768p,
 *                        memory 1..50, seed }
 *   client → prompt    { type, prompt, prompt_version }
 *   client → stop      { type }
 *   server → chunk     { chunk_index, prompt_version, playback_seconds, ... }
 *   server → configured | prompt_applied | prompt_pending | prompt_rejected |
 *            error { code, error } | deadline_missed | stream_exhausted |
 *            session_info | chunk_metrics | session_metrics | pong */
import { createFalClient } from "@fal-ai/client";
import { wma } from "@fal-ai/client/realtime";

export interface EpisodeSpec {
  jobId: string;
  title: string;
  premise: string;
  beats: string[];
  beatSeconds: number;
  duration: number;
  model: string;
  resolution: string;
  aspectRatio: string;
}

interface StartOptions {
  key: string;
  fake: boolean;
  /** Give up if no decodable frame arrives within this many ms. */
  mediaTimeoutMs: number;
}

/** A failure with enough shape for the station to decide whether another
 * billed session could possibly succeed. */
export class DirectorError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean,
    public balanceLock = false,
  ) {
    super(message);
  }
}

/** Server error codes for which the same premise/beats would fail again. */
const NON_RETRYABLE_CODES = new Set([
  "content_policy",
  "immutable_settings",
  "invalid_message",
  "not_configured",
  "invalid_initial_image",
]);

declare global {
  interface Window {
    __recorderEvent: (json: string) => void;
    __recorderChunk: (base64: string) => void;
    startRecording: (spec: EpisodeSpec, opts: StartOptions) => Promise<void>;
  }
}

function emit(type: string, detail: Record<string, unknown> = {}) {
  window.__recorderEvent(JSON.stringify({ type, at: Date.now(), ...detail }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

/** Everything that can end a recording early: a session failure (reject) or
 * the runner finishing on its own (resolve). */
interface Cutoff {
  /** Rejects on failure. */
  failed: Promise<never>;
  /** Resolves when the stream ended cleanly (stream_exhausted). */
  ended: Promise<void>;
}

/** Wait until the stream's video track has actually presented a frame, so
 * the recording does not open with seconds of black while the runner warms
 * up. Bounded: a session that negotiates but never decodes must not wedge
 * the worker. */
function waitForFirstFrame(stream: MediaStream, timeoutMs: number, cutoff: Cutoff): Promise<void> {
  const video = document.querySelector("video") as HTMLVideoElement;
  video.srcObject = stream;
  video.muted = true;
  const firstFrame = new Promise<void>((resolve) => {
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => void;
    };
    if (anyVideo.requestVideoFrameCallback) {
      anyVideo.requestVideoFrameCallback(() => resolve());
    } else {
      video.addEventListener("playing", () => resolve(), { once: true });
    }
    void video.play().catch(() => resolve());
  });
  const timeout = sleep(timeoutMs).then(() => {
    throw new DirectorError("no decodable video frame within timeout", "no_media", true);
  });
  return Promise.race([firstFrame, timeout, cutoff.failed]);
}

/** Record up to `seconds` of the stream, streaming webm chunks to Node every
 * second. Stops early on failure (throws after flushing) or when the runner
 * ends the stream (returns what was captured). */
async function record(
  stream: MediaStream,
  seconds: number,
  firstFrameTimeoutMs: number,
  cutoff: Cutoff,
): Promise<number> {
  await waitForFirstFrame(stream, firstFrameTimeoutMs, cutoff);
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const pending: Promise<void>[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      pending.push(blobToBase64(e.data).then((b64) => window.__recorderChunk(b64)));
    }
  };
  const started = performance.now();
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start(1000);
  emit("recording_started", { mimeType: recorder.mimeType });

  let failure: unknown = null;
  let endedEarly = false;
  try {
    await Promise.race([
      sleep(seconds * 1000),
      cutoff.ended.then(() => {
        endedEarly = true;
      }),
      cutoff.failed,
    ]);
  } catch (err) {
    failure = err;
  }
  recorder.stop();
  await stopped;
  await Promise.all(pending);
  const recordedSeconds = (performance.now() - started) / 1000;
  emit("recording_stopped", { recordedSeconds, endedEarly, failed: Boolean(failure) });
  if (failure) throw failure;
  return recordedSeconds;
}

function neverEnds(): Cutoff {
  return { failed: new Promise<never>(() => {}), ended: new Promise<void>(() => {}) };
}

/** A synthetic stream (canvas + oscillator) so the whole Node pipeline can be
 * exercised without spending a fal session. */
function fakeStream(spec: EpisodeSpec): MediaStream {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 2) % 360} 60% 30%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "28px sans-serif";
    ctx.fillText(`FAKE DIRECTOR — ${spec.title}`, 20, 60);
    ctx.fillText(`beat ${Math.min(spec.beats.length, Math.floor(frame / 24 / spec.beatSeconds) + 1)}/${spec.beats.length}`, 20, 110);
    ctx.fillText(`t=${(frame / 24).toFixed(1)}s`, 20, 160);
    requestAnimationFrame(draw);
  };
  draw();
  const stream = canvas.captureStream(24);
  const audio = new AudioContext();
  const osc = audio.createOscillator();
  osc.frequency.value = 220;
  const gain = audio.createGain();
  gain.gain.value = 0.05;
  const dest = audio.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  return stream;
}

async function runFake(spec: EpisodeSpec, opts: StartOptions): Promise<void> {
  const stream = fakeStream(spec);
  // Mimic the director's chunk cadence so beat scheduling is visible in logs.
  let chunk = 0;
  const ticker = setInterval(() => {
    emit("server", { message: { type: "chunk", chunk_index: chunk, fake: true } });
    chunk += 1;
  }, spec.beatSeconds * 1000);
  try {
    await record(stream, spec.duration, opts.mediaTimeoutMs, neverEnds());
  } finally {
    clearInterval(ticker);
  }
}

function classify(error: unknown): DirectorError {
  if (error instanceof DirectorError) return error;
  const e = error as { status?: number; body?: { detail?: unknown }; message?: string };
  const detail = typeof e?.body?.detail === "string" ? e.body.detail : "";
  const message = detail || e?.message || String(error);
  // fal 403s with "User is locked. Reason: Exhausted balance." when the
  // account runs dry (same signature lib/fal.ts watches for on the queue path).
  if (e?.status === 403 || /locked|balance/i.test(message)) {
    return new DirectorError(message, "balance_lock", false, true);
  }
  return new DirectorError(message, "transport", true);
}

async function runDirector(spec: EpisodeSpec, opts: StartOptions): Promise<void> {
  const fal = createFalClient({
    credentials: opts.key,
    suppressLocalCredentialsWarning: true,
  });

  let promptVersion = 1;
  let nextBeat = 1; // beat 0 rides along with the configure prompt
  let fail!: (err: DirectorError) => void;
  let end!: () => void;
  const cutoff: Cutoff = {
    failed: new Promise<never>((_, reject) => {
      fail = (err) => reject(err);
    }),
    ended: new Promise<void>((resolve) => {
      end = resolve;
    }),
  };
  // Surface the failure to whoever is awaiting; unobserved rejections are
  // expected while we are between awaits.
  cutoff.failed.catch(() => {});

  let mediaResolve!: (stream: MediaStream) => void;
  const media = new Promise<MediaStream>((resolve) => {
    mediaResolve = resolve;
  });

  const handle = fal.realtime.open(wma(spec.model), {
    receive: ["video", "audio"],
    onMedia: (stream) => {
      emit("media", {
        video: stream.getVideoTracks().length,
        audio: stream.getAudioTracks().length,
      });
      mediaResolve(stream);
    },
    onData: (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw);
      } catch {
        emit("server_raw", { raw: raw.slice(0, 300) });
        return;
      }
      emit("server", { message });
      const type = message.type;
      if (type === "chunk") {
        // Chunk k just landed; direct the next one with the next beat.
        if (nextBeat < spec.beats.length) {
          promptVersion += 1;
          handle.send({
            type: "prompt",
            prompt: spec.beats[nextBeat],
            prompt_version: promptVersion,
          });
          emit("beat_sent", { beat: nextBeat, prompt_version: promptVersion });
          nextBeat += 1;
        }
      } else if (type === "error") {
        const code = String(message.code ?? "unknown");
        fail(
          new DirectorError(
            `director error ${code}: ${String(message.error ?? "")}`,
            code,
            !NON_RETRYABLE_CODES.has(code),
          ),
        );
      } else if (type === "prompt_rejected") {
        fail(
          new DirectorError(
            `director rejected prompt v${message.prompt_version}: ${message.reason}`,
            "prompt_rejected",
            false,
          ),
        );
      } else if (type === "stream_exhausted") {
        end();
      }
    },
    onState: (state) => {
      emit("state", { state });
      if (state === "failed") fail(new DirectorError("session failed", "transport", true));
      if (state === "closed") end();
    },
    onDiagnostic: (event) => emit("diagnostic", { event }),
    onError: (error) => fail(classify(error)),
  });

  handle.send({
    protocol_version: 1,
    type: "configure",
    prompt: `${spec.premise}\n\nOpening: ${spec.beats[0]}`,
    prompt_version: promptVersion,
    aspect_ratio: spec.aspectRatio,
    resolution: spec.resolution,
    memory: Math.min(50, Math.max(1, spec.beats.length + 2)),
  });
  emit("configured_sent", { beats: spec.beats.length, duration: spec.duration });

  const noMedia = sleep(opts.mediaTimeoutMs).then(() => {
    throw new DirectorError("no media within timeout", "no_media", true);
  });
  try {
    const stream = await Promise.race([media, noMedia, cutoff.failed]);
    await record(stream, spec.duration, opts.mediaTimeoutMs, cutoff);
  } finally {
    try {
      handle.send({ type: "stop" });
      // Give the control channel a moment to flush the stop before teardown,
      // otherwise the runner keeps the (billed) session open until its own
      // timeout.
      await sleep(500);
    } catch {
      // closing anyway
    }
    await handle.close();
    emit("closed");
  }
}

window.startRecording = async (spec, opts) => {
  try {
    if (opts.fake) await runFake(spec, opts);
    else await runDirector(spec, opts);
    emit("done");
  } catch (err) {
    const e = classify(err);
    emit("failed", {
      error: e.message,
      code: e.code,
      retryable: e.retryable,
      balanceLock: e.balanceLock,
    });
    throw e;
  }
};
