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
 *                        aspect_ratio, resolution, memory, seed }
 *   client → prompt    { type, prompt, prompt_version }
 *   client → stop      { type }
 *   server → chunk     { chunk_index, prompt_version, playback_seconds, ... }
 *   server → prompt_applied | prompt_pending | prompt_rejected | error |
 *            deadline_missed | stream_exhausted | configured | session_info */
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
  /** Give up if no media arrives within this many ms. */
  mediaTimeoutMs: number;
}

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

/** Wait until the stream's video track has actually presented a frame, so
 * the recording does not open with seconds of black while the runner warms up. */
function waitForFirstFrame(stream: MediaStream): Promise<void> {
  const video = document.querySelector("video") as HTMLVideoElement;
  video.srcObject = stream;
  video.muted = true;
  return new Promise((resolve) => {
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
}

/** Record `seconds` of the stream, streaming webm chunks to Node every second. */
async function record(stream: MediaStream, seconds: number): Promise<number> {
  await waitForFirstFrame(stream);
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
  await new Promise((r) => setTimeout(r, seconds * 1000));
  recorder.stop();
  await stopped;
  await Promise.all(pending);
  const recordedSeconds = (performance.now() - started) / 1000;
  emit("recording_stopped", { recordedSeconds });
  return recordedSeconds;
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

async function runFake(spec: EpisodeSpec): Promise<void> {
  const stream = fakeStream(spec);
  // Mimic the director's chunk cadence so beat scheduling is visible in logs.
  let chunk = 0;
  const ticker = setInterval(() => {
    emit("server", { message: { type: "chunk", chunk_index: chunk, fake: true } });
    chunk += 1;
  }, spec.beatSeconds * 1000);
  try {
    await record(stream, spec.duration);
  } finally {
    clearInterval(ticker);
  }
}

async function runDirector(spec: EpisodeSpec, opts: StartOptions): Promise<void> {
  const fal = createFalClient({
    credentials: opts.key,
    suppressLocalCredentialsWarning: true,
  });

  let promptVersion = 1;
  let nextBeat = 1; // beat 0 rides along with the configure prompt
  let failure: Error | null = null;
  let mediaResolve!: (stream: MediaStream) => void;
  let mediaReject!: (err: Error) => void;
  const media = new Promise<MediaStream>((resolve, reject) => {
    mediaResolve = resolve;
    mediaReject = reject;
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
        failure = new Error(`director error ${message.code}: ${message.error}`);
        mediaReject(failure);
      } else if (type === "prompt_rejected") {
        failure = new Error(`director rejected prompt v${message.prompt_version}: ${message.reason}`);
        mediaReject(failure);
      }
    },
    onState: (state) => emit("state", { state }),
    onDiagnostic: (event) => emit("diagnostic", { event }),
    onError: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
      mediaReject(failure);
    },
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

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("no media within timeout")), opts.mediaTimeoutMs),
  );
  try {
    const stream = await Promise.race([media, timeout]);
    await record(stream, spec.duration);
    if (failure) throw failure;
  } finally {
    try {
      handle.send({ type: "stop" });
    } catch {
      // closing anyway
    }
    await handle.close();
    emit("closed");
  }
}

window.startRecording = async (spec, opts) => {
  try {
    if (opts.fake) await runFake(spec);
    else await runDirector(spec, opts);
    emit("done");
  } catch (err) {
    emit("failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};
