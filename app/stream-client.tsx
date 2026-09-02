"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { ActivityItem, NowPlaying, ViewerSample } from "@/lib/types";
import {
  broadcastPurchase,
  hueForId,
  loadIdentity,
  type Identity,
} from "./identity";
import ShareButton from "./share-button";

interface NowResponse extends NowPlaying {
  priceSats: number;
  mockMode: { fal: boolean; llm: boolean; voltage: boolean };
  store: "redis" | "memory";
  falPaused?: boolean;
  configError?: string;
  viewers?: { count: number; sample: ViewerSample[] };
  activity?: ActivityItem[];
}

type ModalState =
  | { phase: "closed" }
  | { phase: "compose"; idea: string; credit: string; busy: boolean; error?: string }
  | { phase: "rejected"; reason: string }
  | { phase: "invoice_pending"; jobId: string; title: string; sats: number }
  | { phase: "invoice"; jobId: string; title: string; bolt11: string; sats: number }
  | { phase: "generating"; jobId: string; title: string }
  | { phase: "deferred"; title: string }
  | { phase: "done"; title: string };

const POLL_MS = 8000;

/** BIP-177 display: sats denominated with the bitcoin symbol, e.g. ₿2,600. */
const fmtBtc = (sats: number) => `₿${sats.toLocaleString("en-US")}`;

export default function StreamClient() {
  const [now, setNow] = useState<NowResponse | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [modal, setModal] = useState<ModalState>({ phase: "closed" });
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [toasts, setToasts] = useState<ActivityItem[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentClipId = useRef<string | null>(null);
  const lastBootstrap = useRef(0);
  const lastDrain = useRef(0);
  const identityRef = useRef<Identity | null>(null);
  const seenActivity = useRef<Set<string> | null>(null);
  // Whether we should be playing with sound. Starts true: we attempt unmuted
  // autoplay and downgrade to muted+tap-hint if the browser blocks it.
  const soundIntent = useRef(true);

  const fetchNow = useCallback(async () => {
    try {
      const me = identityRef.current;
      const qs = me
        ? `?vid=${me.shortId}&vn=${encodeURIComponent(me.name)}`
        : "";
      const res = await fetch(`/api/now${qs}`);
      const data = (await res.json()) as NowResponse;
      setNow(data);

      // Toast activity that arrived since our last poll. The first poll
      // seeds the seen-set silently so we don't replay history on load.
      const items = data.activity ?? [];
      if (seenActivity.current === null) {
        seenActivity.current = new Set(items.map((a) => a.id));
      } else {
        const seen = seenActivity.current;
        const fresh = items.filter((a) => !seen.has(a.id));
        for (const a of fresh) seen.add(a.id);
        if (fresh.length) {
          setToasts((t) => [...t, ...fresh].slice(-4));
          for (const a of fresh) {
            setTimeout(
              () => setToasts((t) => t.filter((x) => x.id !== a.id)),
              7000,
            );
          }
        }
      }

      // Opportunistically retry deferred paid jobs (cheap no-op when empty).
      if (Date.now() - lastDrain.current > 5 * 60_000) {
        lastDrain.current = Date.now();
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ drain: true }),
        }).catch(() => {});
      }

      // Bootstrap: empty/thin library → ask the server to write a house clip.
      if (data.needsBootstrap && Date.now() - lastBootstrap.current > 60_000) {
        lastBootstrap.current = Date.now();
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ house: true }),
        }).then(() => fetchNow()).catch(() => {});
      }
    } catch {
      // network hiccup — keep playing whatever we have
    }
  }, []);

  useEffect(() => {
    // Mint/load the browser's nostr identity before the first heartbeat.
    const me = loadIdentity();
    identityRef.current = me;
    setIdentity(me);
    fetchNow();
    const t = setInterval(fetchNow, POLL_MS);
    return () => clearInterval(t);
  }, [fetchNow]);

  // Sync the <video> element to the broadcast schedule. Sound strategy:
  // try unmuted autoplay first (works on desktop when the browser allows
  // it); when blocked, fall back to muted playback and wait for a tap.
  useEffect(() => {
    const video = videoRef.current;
    const clip = now?.clip;
    if (!video || !clip) return;
    if (currentClipId.current !== clip.id) {
      currentClipId.current = clip.id;
      video.src = clip.videoUrl;
      video.currentTime = now.offsetMs / 1000;
      video.muted = !soundIntent.current;
      video
        .play()
        .then(() => {
          if (soundIntent.current) setSoundOn(true);
        })
        .catch(() => {
          if (!video.muted) {
            // Unmuted autoplay blocked — retry muted, keep the tap hint up.
            video.muted = true;
            soundIntent.current = false;
            setSoundOn(false);
            video.play().catch(() => {});
          }
        });
    }
  }, [now]);

  const setSound = useCallback((on: boolean) => {
    const video = videoRef.current;
    soundIntent.current = on;
    setSoundOn(on);
    if (video) {
      video.muted = !on;
      if (on) {
        video.play().catch(() => {
          // Browser still refused unmuted playback — never freeze the
          // broadcast: fall back to muted and keep the tap hint up.
          video.muted = true;
          soundIntent.current = false;
          setSoundOn(false);
          video.play().catch(() => {});
        });
      }
    }
  }, []);

  // A tap anywhere on the video is the user gesture that unlocks audio.
  const enableSoundOnTap = useCallback(() => {
    if (!soundIntent.current) setSound(true);
  }, [setSound]);

  const onEnded = useCallback(() => {
    currentClipId.current = null;
    fetchNow();
  }, [fetchNow]);

  return (
    <main className="relative h-dvh w-dvw overflow-hidden bg-void">
      {/* ---- video ---- */}
      <div className="scanlines absolute inset-0" onClick={enableSoundOnTap}>
        <video
          ref={videoRef}
          muted
          playsInline
          onEnded={onEnded}
          className="h-full w-full object-contain"
        />
        {now?.clip && !soundOn && (
          <div className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 rounded-sm border-2 border-mustard bg-black/75 px-4 py-2 text-xs font-bold tracking-[0.2em] text-mustard">
            🔇 TAP FOR SOUND
          </div>
        )}
        {!now?.clip && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="font-[family-name:var(--font-display)] text-5xl text-mustard md:text-7xl">
              INFINITE
            </div>
            <div className="text-teal blink">● TUNING THE ANTENNA…</div>
            <div className="max-w-sm text-center text-sm opacity-60">
              The channel is warming up. First cartoon incoming.
            </div>
          </div>
        )}
      </div>

      {/* ---- top bar ---- */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <span className="font-[family-name:var(--font-display)] text-2xl leading-none text-mustard drop-shadow-[3px_3px_0_#e63946]">
            INFINITE
          </span>
          <span className="rounded-sm border-2 border-danger bg-black/60 px-2 py-0.5 text-xs font-bold tracking-widest text-danger">
            <span className="blink">●</span> {now?.rerun ? "RERUN" : "ON AIR"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {now?.viewers && now.viewers.count > 0 && (
            <div
              className="flex items-center gap-2 rounded-sm border-2 border-cream/30 bg-black/60 px-2 py-1"
              title={now.viewers.sample.map((v) => v.name).join(", ")}
            >
              <div className="flex -space-x-2">
                {now.viewers.sample.slice(0, 5).map((v) => (
                  <ViewerAvatar key={v.id} viewer={v} />
                ))}
              </div>
              <span className="text-xs font-bold tracking-wider text-cream/80">
                {now.viewers.count} watching
              </span>
            </div>
          )}
          {now?.clip && (
            <ShareButton clipId={now.clip.id} title={now.clip.title} />
          )}
          <button
            onClick={() => setSound(!soundOn)}
            className="rounded-sm border-2 border-cream/60 bg-black/60 px-3 py-1 text-xs font-bold tracking-widest hover:border-teal hover:text-teal"
          >
            {soundOn ? "SOUND: ON" : "SOUND: OFF"}
          </button>
        </div>
      </div>

      {/* ---- activity toasts ---- */}
      <div className="pointer-events-none absolute bottom-20 right-4 z-20 flex flex-col items-end gap-2">
        {toasts.map((a) => (
          <div
            key={a.id}
            className="max-w-xs border-2 border-teal bg-black/85 px-3 py-2 text-sm shadow-[4px_4px_0_#e63946]"
          >
            🎬 <span className="text-mustard">{a.name}</span> added{" "}
            <span className="text-teal">“{a.title}”</span>
          </div>
        ))}
      </div>

      {/* ---- config error banner ---- */}
      {now?.configError && (
        <div className="absolute left-0 right-0 top-14 mx-auto w-fit max-w-[90%] border-2 border-danger bg-black/85 px-4 py-2 text-center text-sm text-danger">
          ⚠ STATION MISCONFIGURED: {now.configError}
        </div>
      )}

      {/* ---- lower third ---- */}
      <div className="absolute bottom-16 left-0 right-0 flex flex-col gap-2 px-4">
        {now?.clip && (
          <div className="w-fit max-w-full border-l-8 border-orange bg-black/70 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.3em] text-teal">
              Now showing
            </div>
            <div className="font-[family-name:var(--font-display)] text-lg text-cream">
              {now.clip.title}
            </div>
            <div className="text-xs opacity-70">
              {now.clip.kind === "paid"
                ? `submitted by ${now.clip.credit || "an anonymous weirdo"}`
                : "written by the house AI"}
            </div>
          </div>
        )}
      </div>

      {/* ---- bottom bar ---- */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-3 border-t-4 border-mustard bg-panel px-4 py-3">
        <button
          onClick={() =>
            setModal({ phase: "compose", idea: "", credit: "", busy: false })
          }
          disabled={Boolean(now?.falPaused)}
          className="shrink-0 rounded-sm border-2 border-orange bg-orange px-4 py-2 font-[family-name:var(--font-display)] text-sm text-void hover:bg-mustard hover:border-mustard disabled:opacity-50 disabled:hover:bg-orange disabled:hover:border-orange"
        >
          {now?.falPaused
            ? "REFUELING… BACK SOON"
            : `ADD TO STREAM · ${now ? fmtBtc(now.priceSats) : "…"}`}
        </button>
        <div className="relative flex-1 overflow-hidden whitespace-nowrap text-sm text-teal">
          <div className="ticker inline-block">
            <TickerText now={now} />
            <TickerText now={now} />
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-5 md:flex">
          <a
            href="https://atlbitlab.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 opacity-80 transition-opacity hover:opacity-100"
          >
            <span className="text-[11px] font-bold tracking-[0.2em]">AN</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/atlbitlab-white.png" alt="ATL BitLab" className="h-9 w-auto" />
            <span className="text-[11px] font-bold tracking-[0.2em]">PROJECT</span>
          </a>
          <span className="h-7 w-px bg-cream/30" />
          <a
            href="https://voltage.cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 opacity-80 transition-opacity hover:opacity-100"
          >
            <span className="text-[11px] font-bold tracking-[0.2em]">POWERED BY</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/voltage-white.svg" alt="Voltage" className="h-5 w-auto" />
          </a>
        </div>
      </div>

      {modal.phase !== "closed" && (
        <SubmitModal
          modal={modal}
          setModal={setModal}
          now={now}
          identity={identity}
          onScheduled={fetchNow}
        />
      )}
    </main>
  );
}

function ViewerAvatar({ viewer }: { viewer: ViewerSample }) {
  const hue = hueForId(viewer.id);
  const initials = viewer.name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
  return (
    <span
      className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-void text-[9px] font-bold text-void"
      style={{ backgroundColor: `hsl(${hue} 70% 60%)` }}
      title={viewer.name}
    >
      {initials}
    </span>
  );
}

function TickerText({ now }: { now: NowResponse | null }) {
  const upNext = now?.upNext?.length
    ? now.upNext.map((c) => `UP NEXT: ${c.title}`).join("  ★  ")
    : "PAY BITCOIN, GET CARTOONS";
  return (
    <span className="mx-4">
      {upNext} ★ AN ENDLESS AI CARTOON CHANNEL ROASTING BITCOIN, FREEDOM TECH
      &amp; AI ★ {now ? `${now.libraryCount} clips in the vault` : ""} ★{" "}
    </span>
  );
}

function SubmitModal({
  modal,
  setModal,
  now,
  identity,
  onScheduled,
}: {
  modal: ModalState;
  setModal: (m: ModalState) => void;
  now: NowResponse | null;
  identity: Identity | null;
  onScheduled: () => void;
}) {
  // Poll our Redis-backed job immediately while the generated webhook is
  // delivering the invoice, then at a calmer cadence while awaiting payment.
  useEffect(() => {
    if (modal.phase !== "invoice_pending" && modal.phase !== "invoice") return;
    const { jobId, title } = modal;
    const startedAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function check() {
      try {
        const res = await fetch(`/api/payment/${jobId}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.status === "paid" || data.status === "done" || data.status === "generating") {
          // Payment confirmed: shout it to nostr with our browser identity.
          broadcastPurchase(title);
          setModal({ phase: "generating", jobId, title });
          return;
        }
        if (data.status === "failed") {
          setModal({ phase: "rejected", reason: "Payment expired or failed. No bitcoin was harmed." });
          return;
        }
        if (
          modal.phase === "invoice_pending" &&
          typeof data.invoice?.bolt11 === "string" &&
          typeof data.invoice?.sats === "number"
        ) {
          setModal({
            phase: "invoice",
            jobId,
            title,
            bolt11: data.invoice.bolt11,
            sats: data.invoice.sats,
          });
          return;
        }
      } catch {
        // keep polling
      }
      if (!cancelled) {
        const waitingForInvoice = modal.phase === "invoice_pending";
        const delay =
          waitingForInvoice && Date.now() - startedAt < 5_000 ? 300 : 1_000;
        timer = setTimeout(check, delay);
      }
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [modal, setModal]);

  // Drive generation once paid.
  useEffect(() => {
    if (modal.phase !== "generating") return;
    const { jobId, title } = modal;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (data.status === "done") {
          onScheduled();
          setModal({ phase: "done", title });
        } else if (data.status === "deferred") {
          setModal({ phase: "deferred", title });
        } else if (data.status === "generating") {
          // Another instance is on it; poll until done.
          const poll = setInterval(async () => {
            const s = await (await fetch(`/api/payment/${jobId}`)).json();
            if (s.status === "done") {
              clearInterval(poll);
              onScheduled();
              setModal({ phase: "done", title });
            }
          }, 3000);
        } else {
          setModal({ phase: "rejected", reason: "Generation failed. Ping the station manager." });
        }
      } catch {
        if (!cancelled)
          setModal({ phase: "rejected", reason: "Generation failed. Ping the station manager." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modal, setModal, onScheduled]);

  async function submit() {
    if (modal.phase !== "compose") return;
    setModal({ ...modal, busy: true, error: undefined });
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea: modal.idea,
          credit: modal.credit || identity?.name || "",
        }),
      });
      const data = await res.json();
      if (data.rejected) {
        setModal({ phase: "rejected", reason: data.reason });
      } else if (data.jobId) {
        if (data.invoice?.bolt11) {
          setModal({
            phase: "invoice",
            jobId: data.jobId,
            title: data.title,
            bolt11: data.invoice.bolt11,
            sats: data.invoice.sats,
          });
        } else {
          setModal({
            phase: "invoice_pending",
            jobId: data.jobId,
            title: data.title,
            sats: data.sats,
          });
        }
      } else {
        setModal({ ...modal, busy: false, error: data.error ?? "Something broke." });
      }
    } catch {
      setModal({ ...modal, busy: false, error: "Network error. Try again." });
    }
  }

  async function giveMeAnIdea() {
    if (modal.phase !== "compose") return;
    setModal({ ...modal, busy: true, error: undefined });
    try {
      const res = await fetch("/api/idea");
      const data = await res.json();
      setModal({
        phase: "compose",
        idea: data.idea ?? "",
        credit: modal.credit,
        busy: false,
        error: data.error,
      });
    } catch {
      setModal({ ...modal, busy: false, error: "The writers' room hung up." });
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md border-4 border-mustard bg-panel p-5 shadow-[8px_8px_0_#e63946]">
        <div className="mb-3 flex items-start justify-between">
          <h2 className="font-[family-name:var(--font-display)] text-xl text-mustard">
            {modal.phase === "done" ? "SCHEDULED!" : "ADD TO STREAM"}
          </h2>
          <button
            onClick={() => setModal({ phase: "closed" })}
            className="border-2 border-cream/40 px-2 text-sm hover:border-danger hover:text-danger"
          >
            ✕
          </button>
        </div>

        {modal.phase === "compose" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm opacity-80">
              Pitch a scene. The house AI checks the vibe (playful, not mean),
              writes it up, and your cartoon airs on the stream.
            </p>
            <textarea
              value={modal.idea}
              onChange={(e) => setModal({ ...modal, idea: e.target.value })}
              placeholder="e.g. A maximalist knight refuses to pay a troll's toll because the bridge is a custodial solution…"
              rows={4}
              maxLength={500}
              className="w-full resize-none border-2 border-teal/60 bg-void p-2 text-sm outline-none focus:border-teal"
            />
            <input
              value={modal.credit}
              onChange={(e) => setModal({ ...modal, credit: e.target.value })}
              placeholder={`credit (default: ${identity?.name ?? "anonymous"})`}
              maxLength={50}
              className="w-full border-2 border-teal/60 bg-void p-2 text-sm outline-none focus:border-teal"
            />
            {modal.error && <div className="text-sm text-danger">{modal.error}</div>}
            <div className="flex gap-2">
              <button
                onClick={giveMeAnIdea}
                disabled={modal.busy}
                className="flex-1 border-2 border-teal px-3 py-2 text-xs font-bold tracking-wider text-teal hover:bg-teal hover:text-void disabled:opacity-40"
              >
                GIVE ME AN IDEA
              </button>
              <button
                onClick={submit}
                disabled={modal.busy || modal.idea.trim().length < 5}
                className="flex-1 border-2 border-orange bg-orange px-3 py-2 text-xs font-bold tracking-wider text-void hover:bg-mustard hover:border-mustard disabled:opacity-40"
              >
                {modal.busy ? "CHECKING…" : `PAY ${now ? fmtBtc(now.priceSats) : "…"}`}
              </button>
            </div>
          </div>
        )}

        {modal.phase === "rejected" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{modal.reason}</p>
            <button
              onClick={() => setModal({ phase: "compose", idea: "", credit: "", busy: false })}
              className="border-2 border-teal px-3 py-2 text-xs font-bold tracking-wider text-teal hover:bg-teal hover:text-void"
            >
              TRY ANOTHER IDEA
            </button>
          </div>
        )}

        {modal.phase === "invoice_pending" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="font-[family-name:var(--font-display)] text-lg text-teal blink">
              PRINTING INVOICE…
            </div>
            <p className="text-center text-sm opacity-80">
              Voltage is generating the payment code for{" "}
              <span className="text-mustard">“{modal.title}”</span>.
            </p>
          </div>
        )}

        {modal.phase === "invoice" && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-center text-sm">
              <span className="text-mustard">“{modal.title}”</span> is greenlit.
              Pay <b>{fmtBtc(modal.sats)}</b> to roll cameras.
            </p>
            <div className="bg-white p-3">
              <QRCodeSVG value={`lightning:${modal.bolt11}`} size={200} />
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(modal.bolt11)}
              className="w-full truncate border-2 border-cream/40 px-3 py-2 text-xs hover:border-teal hover:text-teal"
              title={modal.bolt11}
            >
              COPY INVOICE · {modal.bolt11.slice(0, 28)}…
            </button>
            <div className="text-xs text-teal blink">waiting for payment…</div>
            <div className="flex items-center gap-1.5 opacity-50">
              <span className="text-[9px] font-bold tracking-[0.2em]">POWERED BY</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/voltage-white.svg" alt="Voltage" className="h-3 w-auto" />
            </div>
          </div>
        )}

        {modal.phase === "generating" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="font-[family-name:var(--font-display)] text-lg text-teal">
              ANIMATING…
            </div>
            <p className="text-center text-sm opacity-80">
              Paid. The render farm is drawing{" "}
              <span className="text-mustard">“{modal.title}”</span> frame by
              frame. ~15 seconds.
            </p>
          </div>
        )}

        {modal.phase === "deferred" && (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="font-[family-name:var(--font-display)] text-lg text-mustard">
              QUEUED!
            </div>
            <p className="text-center text-sm opacity-80">
              Your payment landed and{" "}
              <span className="text-mustard">“{modal.title}”</span> is locked in.
              The render farm hit a hiccup, so your cartoon is queued and will
              air automatically once it recovers — no extra sats needed.
            </p>
            <button
              onClick={() => setModal({ phase: "closed" })}
              className="border-2 border-orange bg-orange px-4 py-2 text-xs font-bold tracking-wider text-void hover:bg-mustard hover:border-mustard"
            >
              BACK TO THE STREAM
            </button>
          </div>
        )}

        {modal.phase === "done" && (
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-center text-sm">
              <span className="text-mustard">“{modal.title}”</span> is queued on
            the broadcast. Watch for it — it airs next.
            </p>
            <button
              onClick={() => setModal({ phase: "closed" })}
              className="border-2 border-orange bg-orange px-4 py-2 text-xs font-bold tracking-wider text-void hover:bg-mustard hover:border-mustard"
            >
              BACK TO THE STREAM
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
