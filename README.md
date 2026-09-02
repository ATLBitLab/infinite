# INFINITE

An infinite AI-generated cartoon livestream. Y2K / early-Adult-Swim-style animation
roasting bitcoin, freedom tech, and AI. Viewers pay sats over Lightning to put their
ideas on the broadcast.

Built at [ATL BitLab](https://atlbitlab.com).

## How it works

```text
viewer idea ──► durable "preparing" job ──► UI shows AI REVIEW immediately
                           │ post-response worker; cron repairs interruptions
                           ▼
                 Claude vibe-check + scriptwriting
                           │ complete prompt stored before payment
                           ▼
                 Lightning invoice (Voltage) ──► QR code
                           │ paid
                           ▼
                 fal.ai render ──► scheduled playlist ──► "synthetic live" player
```

- **Synthetic live**: no streaming servers. Every clip gets an air slot; `/api/now`
  computes the current clip + offset from wall-clock time, so every viewer sees the
  same broadcast. When nothing fresh is scheduled, a deterministic rerun loop plays
  the library.
- **House content**: when the library is thin — or the newest clip is older than
  `HOUSE_FRESH_HOURS` (default 4) — a viewer's player triggers an auto-written
  clip (locked + capped by `MAX_DAILY_HOUSE_CLIPS` so it can't burn money).
  Generation is always viewer-triggered: nobody watching, nothing spent.
- **Moderation before payment**: Claude rejects mean-spirited stuff up front, so
  nobody pays for a clip that won't air.
- **Responsive submission**: `/api/submit` stores the pitch and returns its job ID
  before Claude runs. The UI shows the AI review stage while a post-response task
  writes the script. Voltage receives an invoice request only after the complete
  render prompt is stored. A submit-flow header makes older open tabs refresh
  instead of interpreting the new preparation state as invoice latency.
- **Mock mode**: with no env vars at all, the app runs on sample videos, canned
  ideas, and fake auto-settling invoices — full flow, zero spend.
- **Live chat (flagged)**: `NEXT_PUBLIC_CHAT_ENABLED=1` (or `?chat=1` on any URL)
  shows a chat panel next to the player. It free-rides on nostr: every visitor
  already has a per-browser nostr key, so messages are NIP-53 live-chat events
  (kind 1311) bound to the station's room address and read straight from public
  relays — no chat server. Every message has a **⚡ FUND** tap that drops its
  text into the pitch form, so it goes through the same AI review + Lightning
  checkout as any submission (fresh job id, moderation re-run, price recomputed;
  nothing in the chat event is trusted). Anyone with a nostr key can post, so
  there is a per-device mute list and a local send throttle, but no server-side
  moderation of chat text.

## Economics

fal MiniMax H3 Max: **$0.05/sec @ 480P, $0.08/sec @ 768P** → a 15s 768P clip costs
**≈ $1.20** (plus ~a cent of LLM). Default submission price is **$2.00 in sats**
(converted at spot, `PRICE_USD`/`PRICE_SATS` to tune), so each paid submission covers
itself plus ~0.6 house clips. House filler is capped per day; the more people submit,
the less filler you need.

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:3000. Copy `.env.example` to `.env.local` and fill keys to go
live service-by-service (each one falls back to mock independently).

## Deploy (Vercel)

1. Import the repo into Vercel.
2. Add an Upstash Redis integration (or set `UPSTASH_REDIS_REST_URL/TOKEN`) —
   required in prod; the in-memory store is dev-only.
3. Set `FAL_KEY`, `ANTHROPIC_API_KEY`, the four Voltage account variables,
   `CRON_SECRET`, and `VOLTAGE_WEBHOOK_ID` / `VOLTAGE_WEBHOOK_SECRET` as
   described below.
4. Deploy. The generate route sets `maxDuration = 300`.

## Voltage webhook

Invoice generation and payment completion use one environment-level webhook.
Create it once after the site has a public HTTPS URL:

```bash
export INFINITE_URL="https://your-deployment.example"
export VOLTAGE_WEBHOOK_ID="$(uuidgen)"
export VOLTAGE_API_URL="${VOLTAGE_API_URL:-https://voltageapi.com/v1}"

curl --fail-with-body \
  --request POST \
  --header "x-api-key: $VOLTAGE_API_KEY" \
  --header "Content-Type: application/json" \
  "$VOLTAGE_API_URL/organizations/$VOLTAGE_ORG_ID/environments/$VOLTAGE_ENV_ID/webhooks" \
  --data "{
    \"id\": \"$VOLTAGE_WEBHOOK_ID\",
    \"url\": \"$INFINITE_URL/api/voltage/webhook\",
    \"name\": \"INFINITE payments\",
    \"events\": [
      {\"receive\": \"generated\"},
      {\"receive\": \"completed\"},
      {\"receive\": \"expired\"},
      {\"receive\": \"failed\"}
    ]
  }"
```

The `202` response contains a one-time `shared_secret`. Save its `id` as
`VOLTAGE_WEBHOOK_ID` and `shared_secret` as `VOLTAGE_WEBHOOK_SECRET` in the
deployment environment, then redeploy. Point production Voltage directly at
the deployed endpoint; deliveries have a two-second response deadline.

For local payload inspection, a Smee channel can forward to the route:

```bash
npx smee-client \
  --url https://smee.io/YOUR_CHANNEL \
  --target http://localhost:3000/api/voltage/webhook
```

Register the Smee URL on a development Voltage environment only. Smee is not a
production relay, and JSON reserialization may prevent raw-body signature
verification; use a deployed preview or raw-byte-preserving HTTPS tunnel when
testing signatures end to end.

### Payment reconciliation

The signed Voltage webhook is the fast path. `receive.generated` writes the
BOLT11 directly to Redis, `receive.completed` records payment, and the browser
observes either update through its short local poll without waiting on the
Payments API.

Reconciliation is only the recovery path. `vercel.json` invokes
`/api/cron/reconcile-payments` once per minute. The job repairs missed payment
events, retries a bounded exact-ID invoice request after persistent `404`
responses, and recovers one interrupted AI preparation per run. Set a random
`CRON_SECRET` of at least 16 characters in Vercel. Vercel supplies it as the
route's bearer token automatically.

The worker claims at most 25 pending jobs per run, checks five concurrently,
and rotates unresolved jobs to prevent one stale payment from blocking newer
ones. Per-minute cron schedules require a Vercel Pro or Enterprise project; on
Hobby, invoke the same authenticated route from an external scheduler or use a
schedule allowed by that plan.

A completed payment atomically enters the existing generation queue. The active
browser starts rendering immediately; if it goes away, a viewer's background
drain picks the paid job up later without requiring another payment event.

## Roadmap

- Simulcast to YouTube/X via restream.io (tiny 24/7 ffmpeg relay playing `/api/now`)
- Nostr zaps / comments overlay
- Mirror fal-hosted clips to durable storage (Vercel Blob)
