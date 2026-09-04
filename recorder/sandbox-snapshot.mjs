/** Build a Vercel Sandbox snapshot with everything the recorder needs
 * (Chromium system libs, ffmpeg, Node deps, the Playwright Chromium
 * build) so a per-episode sandbox boots in about a second instead of
 * spending ~60s on setup. Run from a machine with Vercel credentials:
 *
 *   VERCEL_TOKEN=... VERCEL_TEAM_ID=team_... VERCEL_PROJECT_ID=prj_... \
 *     node recorder/sandbox-snapshot.mjs [repo-ref]
 *
 * then set RECORDER_SANDBOX_SNAPSHOT=<printed id> on the app. Rebuild it
 * whenever recorder/package-lock.json changes; snapshots expire 30 days
 * after their last use. */
import { Sandbox } from "@vercel/sandbox";

const REPO_URL = process.env.RECORDER_REPO_URL ?? "https://github.com/ATLBitLab/infinite.git";
const REPO_REF = process.argv[2] ?? process.env.RECORDER_REPO_REF ?? "main";
const DEPS =
  "git xz nss nspr libxkbcommon atk at-spi2-atk at-spi2-core libXcomposite libXdamage " +
  "libXrandr libXfixes libXcursor libXi libXtst libXScrnSaver libXext mesa-libgbm " +
  "libdrm mesa-libGL mesa-libEGL cups-libs alsa-lib pango cairo gtk3 dbus-libs";

const creds =
  process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
    ? {
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      }
    : {};

async function run(sandbox, script, label) {
  const r = await sandbox.runCommand({ cmd: "bash", args: ["-c", script] });
  const err = (await r.stderr()).trim();
  console.log(`[${label}] exit ${r.exitCode}${err ? "\n" + err.slice(-600) : ""}`);
  if (r.exitCode !== 0) throw new Error(`${label} failed`);
}

const sandbox = await Sandbox.create({
  ...creds,
  runtime: "node24",
  timeout: 10 * 60_000,
  resources: { vcpus: 2 },
});
console.log(`sandbox ${sandbox.name}`);
try {
  await run(sandbox, `sudo dnf install -y -q --skip-broken ${DEPS} >/dev/null 2>&1; sudo ldconfig`, "system deps");
  await run(
    sandbox,
    "cd /tmp && curl -sSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ " +
      "&& sudo install -m 755 ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg " +
      "&& sudo install -m 755 ffmpeg-*-static/ffprobe /usr/local/bin/ffprobe " +
      "&& ffmpeg -version | head -1 && ffprobe -version | head -1",
    "ffmpeg",
  );
  // Warm the npm cache and the Playwright browser cache with the versions
  // the recorder pins; the per-episode script re-runs both, near-instantly.
  await run(
    sandbox,
    `cd /tmp && git clone -q --depth 1 ${REPO_URL} warm && cd warm && git fetch -q --depth 1 origin ${REPO_REF} && git checkout -q FETCH_HEAD ` +
      "&& cd recorder && npm ci --silent --no-audit --no-fund && npx playwright install chromium 2>&1 | tail -1 && cd / && rm -rf /tmp/warm",
    "recorder deps + chromium",
  );
  const snapshot = await sandbox.snapshot();
  console.log(`\nRECORDER_SANDBOX_SNAPSHOT=${snapshot.snapshotId}`);
} finally {
  await sandbox.stop();
}
