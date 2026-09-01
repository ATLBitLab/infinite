# INFINITE

An infinite AI-generated cartoon livestream. Y2K / early-Adult-Swim-style animation
roasting bitcoin, freedom tech, and AI. Viewers pay sats over Lightning to put their
ideas on the broadcast.

Built at [ATL BitLab](https://atlbitlab.com).

## How it works

```
viewer idea ──► Claude (vibe-check + scriptwriting) ──► Lightning invoice (Voltage)
                                                              │ paid
                                                              ▼
                                    fal.ai MiniMax H3 Max (15s clip in ~9s)
                                                              │
                                                              ▼
                              scheduled playlist ──► "synthetic live" player
```

- **Synthetic live**: no streaming servers. Every clip gets an air slot; `/api/now`
  computes the current clip + offset from wall-clock time, so every viewer sees the
  same broadcast. When nothing fresh is scheduled, a deterministic rerun loop plays
  the library.
- **House content**: when the library is thin, the player bootstraps auto-written
  clips (locked + capped by `MAX_DAILY_HOUSE_CLIPS` so it can't burn money).
- **Moderation before payment**: Claude rejects mean-spirited stuff up front, so
  nobody pays for a clip that won't air.
- **Mock mode**: with no env vars at all, the app runs on sample videos, canned
  ideas, and fake auto-settling invoices — full flow, zero spend.

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
3. Set `FAL_KEY`, `ANTHROPIC_API_KEY`, and the four `VOLTAGE_*` vars.
4. Deploy. The generate route sets `maxDuration = 300`.

## Roadmap

- Simulcast to YouTube/X via restream.io (tiny 24/7 ffmpeg relay playing `/api/now`)
- Nostr zaps / comments overlay
- Mirror fal-hosted clips to durable storage (Vercel Blob)
