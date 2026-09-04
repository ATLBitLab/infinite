# INFINITE recorder

Turns paid **H3 Max Director** episodes into mp4 clips. Director
(`minimax/h3-max/director`) is a live WebRTC stream with no queue/mp4 API, so
something has to sit in a real browser, direct the session beat by beat, and
record what comes back. That is this worker.

```
claim job (/api/director)
  → headless Chromium opens the Director session (fal WMA transport)
  → configure prompt = show bible + opening beat; next beat sent as each 10s chunk lands
  → MediaRecorder captures the incoming video+audio → webm
  → ffmpeg → mp4 (h264/aac, faststart) → fal storage upload
  → /api/director complete → the station schedules the Clip
```

## Run it

Needs Node 20+, ffmpeg on PATH, and Chromium for Playwright.

```bash
cd recorder
npm install
npx playwright install chromium

export INFINITE_URL=https://infinite.atlbitlab.com
export RECORDER_SECRET=...   # same value as the app's RECORDER_SECRET
export FAL_KEY=...
npm start                    # polls forever; Ctrl-C to stop
```

The app must have `DIRECTOR_MAX_DURATION` (e.g. `120`) and `RECORDER_SECRET`
set, otherwise no director jobs are ever sold or handed out. The tier is also
only on sale while a recorder is actually polling: every claim refreshes a
3-minute liveness flag, and when it lapses the length slider drops back to
45s so nobody pays for a session nothing would record.

## Dry run without spending

```bash
RECORDER_FAKE=1 RECORDER_FAKE_UPLOAD_URL=https://example.com/fake.mp4 \
INFINITE_URL=http://localhost:3000 RECORDER_SECRET=dev npm run once
```

`RECORDER_FAKE=1` records a synthetic canvas/oscillator stream instead of a
Director session, so the claim → record → transcode → complete loop runs end to
end against a local app in mock mode. `--once` processes a single job and exits.

## Notes

- Run exactly one recorder per station. Each claim opens a billed session and
  hands out a lease; `complete`/`fail` must present that lease, so a second
  worker (or a stalled first one) cannot finish or requeue a job it no longer
  owns.
- A station with a real `FAL_KEY` refuses `RECORDER_FAKE=1` claims, so the
  dry run cannot air a synthetic clip against a real purchase.
- `--once` claims without refreshing the liveness flag, so it never puts
  director lengths on sale by itself.
- A job is handed out at most 3 times (counted at claim, not on reported
  failure, because a crashed recorder reports nothing). Deterministic
  rejections (`content_policy`, `prompt_rejected`, bad configure) stop after
  the first attempt; a fal balance lock pauses all sales on the station.

- Sessions bill a 60s minimum at fal, so the app only routes episodes above
  `MAX_TOTAL_DURATION` (45s) here. Sessions over 2 minutes need fal approval.
- If the recorder dies mid-episode, the job's 15-minute lease expires and the
  next claim picks it up again (bounded by the same retry cap as fal renders).
- `deadline_missed` freezes from the runner are recorded as-is; the log shows
  per-chunk buffer depth so you can tell when that happened.
