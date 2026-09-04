import { Sandbox } from "@vercel/sandbox";
import { config, mockMode } from "./config";
import { getStore } from "./store";

/** Vercel Sandbox recorder for H3 Max Director episodes.
 *
 * Director is a live WebRTC stream, so something has to sit in a browser
 * and record it (recorder/). Rather than a worker that polls forever from a
 * box someone keeps switched on, every paid director job spawns one
 * microVM here: it clones this repo at the deployed commit, runs
 * `recorder --once` against the station for exactly that job, and is
 * stopped by /api/director as soon as the episode is delivered. Nothing
 * runs, and nothing is billed, while no one is buying. */

export function sandboxEnabled(): boolean {
  return config.sandbox.enabled && Boolean(config.recorderSecret) && !mockMode.fal;
}

// One flag per job: its presence means a sandbox is on its way (or running),
// its reason holds the sandbox name so the station can stop it. The TTL
// outlives a session + transcode + upload with room to spare, and is far
// shorter than the recorder's claim lease, so a lost VM is retried.
const SPAWN_FLAG_PREFIX = "recorder-sandbox:";
const SPAWN_TTL_SECONDS = 8 * 60;
const SPAWN_RETRY_SECONDS = 30;

export type SpawnOutcome = "spawned" | "already_spawned" | "disabled" | "error";

function credentials() {
  const { token, teamId, projectId } = config.sandbox;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

function spawnFlag(jobId: string): string {
  return SPAWN_FLAG_PREFIX + jobId;
}

/** Spawn a recorder for this paid job unless one is already on its way. */
export async function spawnRecorderSandbox(jobId: string): Promise<SpawnOutcome> {
  if (!sandboxEnabled()) return "disabled";
  const store = getStore();
  const flag = spawnFlag(jobId);
  if (await store.getFlag(flag)) return "already_spawned";
  // Claim the slot before the (slow) create so a second drain in the same
  // window does not start a second VM.
  await store.setFlag(flag, SPAWN_TTL_SECONDS, "spawning");

  const s = config.sandbox;
  const name = `recorder-${jobId}-${Date.now().toString(36)}`;
  try {
    const base = {
      ...credentials(),
      name,
      timeout: s.timeoutMs,
      resources: { vcpus: s.vcpus },
    };
    const sandbox = s.snapshotId
      ? await Sandbox.create({
          ...base,
          source: { type: "snapshot", snapshotId: s.snapshotId },
        })
      : await Sandbox.create({
          ...base,
          runtime: "node24",
          source: { type: "git", url: s.repoUrl, revision: s.repoRef, depth: 1 },
        });
    await sandbox.writeFiles([
      { path: "/vercel/sandbox/run-recorder.sh", content: RUN_RECORDER_SH, mode: 0o755 },
    ]);
    await sandbox.runCommand({
      cmd: "bash",
      args: ["/vercel/sandbox/run-recorder.sh"],
      detached: true,
      env: {
        INFINITE_URL: config.appUrl,
        RECORDER_SECRET: config.recorderSecret,
        FAL_KEY: config.falKey,
        RECORDER_JOB_ID: jobId,
        RECORDER_REPO_URL: s.repoUrl,
        RECORDER_REPO_REF: s.repoRef,
        RECORDER_PREBUILT: s.snapshotId ? "1" : "",
      },
    });
    await store.setFlag(flag, SPAWN_TTL_SECONDS, name);
    console.log(`spawned sandbox recorder ${name} for job ${jobId} (${s.repoRef})`);
    return "spawned";
  } catch (err) {
    console.error(`sandbox recorder spawn failed for job ${jobId}:`, err);
    // Let the next drain retry soon instead of after the full TTL.
    await store.setFlag(flag, SPAWN_RETRY_SECONDS, "spawn failed");
    return "error";
  }
}

/** Stop the sandbox recording this job, if we spawned one. Best effort: a
 * VM that is already gone, or that a polling worker claimed instead, is
 * not an error. */
export async function releaseRecorderSandbox(jobId: string): Promise<void> {
  if (!config.sandbox.enabled) return;
  const info = await getStore().getFlagInfo(spawnFlag(jobId));
  const name = info?.reason ?? "";
  if (!name.startsWith("recorder-")) return;
  try {
    const sandbox = await Sandbox.get({ ...credentials(), name });
    await sandbox.stop();
    console.log(`stopped sandbox recorder ${name}`);
  } catch (err) {
    console.error(`stopping sandbox recorder ${name} failed:`, err);
  }
}

// Runs inside the VM. A git-sourced sandbox already has the repo checked out
// at /vercel/sandbox; a snapshot-sourced one (RECORDER_PREBUILT=1) has the
// system packages, ffmpeg and Chromium baked in and clones the repo itself.
const CHROMIUM_SYSTEM_DEPS =
  "nss nspr libxkbcommon atk at-spi2-atk at-spi2-core libXcomposite libXdamage " +
  "libXrandr libXfixes libXcursor libXi libXtst libXScrnSaver libXext mesa-libgbm " +
  "libdrm mesa-libGL mesa-libEGL cups-libs alsa-lib pango cairo gtk3 dbus-libs";

export const RUN_RECORDER_SH = `#!/bin/bash
set -euo pipefail
cd /vercel/sandbox
if [ "\${RECORDER_PREBUILT:-}" != "1" ]; then
  sudo dnf install -y -q --skip-broken git xz ${CHROMIUM_SYSTEM_DEPS} >/dev/null 2>&1 || true
  sudo ldconfig || true
  if ! command -v ffmpeg >/dev/null 2>&1; then
    (cd /tmp && curl -sSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ \\
      && sudo install -m 755 ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg)
  fi
fi
if [ ! -d recorder ]; then
  git clone -q --depth 1 "$RECORDER_REPO_URL" app
  cd app
  git fetch -q --depth 1 origin "$RECORDER_REPO_REF" && git checkout -q FETCH_HEAD
fi
cd recorder
npm ci --silent --no-audit --no-fund
npx playwright install chromium >/dev/null 2>&1
exec npm run once
`;
