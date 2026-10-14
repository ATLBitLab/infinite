"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { httpAuthHeader, hueForId, loadIdentity, type Identity } from "../identity";
import ShareButton from "../share-button";

interface HistoryVideo {
  id: string;
  title: string;
  duration: number;
  createdAt: number;
  airAt: number;
  permalink: string;
}

interface PendingJob {
  jobId: string;
  title: string;
  status: string;
  duration?: number;
  createdAt: number;
  error?: string;
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; videos: HistoryVideo[]; pending: PendingJob[] };

const STATUS_LABEL: Record<string, string> = {
  preparing: "IN REVIEW",
  awaiting_payment: "AWAITING PAYMENT",
  paid: "PAID · QUEUED",
  generating: "RENDERING",
  failed: "FAILED",
};

/** This browser's submission history. Everything is keyed to the local nostr
 * key, so the request is signed (NIP-98) and the server answers only for it. */
export default function MeClient() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    setIdentity(loadIdentity());
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me/videos", {
          headers: { Authorization: await httpAuthHeader("/api/me/videos", "GET") },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`history ${res.status}`);
        const data = await res.json();
        if (!cancelled) setLoad({ state: "ready", videos: data.videos, pending: data.pending });
      } catch {
        if (!cancelled) setLoad({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-dvh bg-void">
      {/* ---- top bar ---- */}
      <div className="flex items-center justify-between border-b-4 border-mustard bg-panel p-4">
        <Link
          href="/"
          className="font-[family-name:var(--font-display)] text-2xl leading-none text-mustard drop-shadow-[3px_3px_0_#e63946]"
        >
          INFINITE
        </Link>
        <Link
          href="/"
          className="shrink-0 rounded-sm border-2 border-orange bg-orange px-3 py-1 font-[family-name:var(--font-display)] text-xs text-void hover:border-mustard hover:bg-mustard"
        >
          ● WATCH LIVE
        </Link>
      </div>

      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 md:p-8">
        {/* ---- identity ---- */}
        <div className="flex items-center gap-4">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4 border-void text-lg font-bold text-void shadow-[3px_3px_0_#e63946]"
            style={{
              backgroundColor: identity ? `hsl(${hueForId(identity.shortId)} 70% 60%)` : "#333",
            }}
          >
            {identity ? initials(identity.name) : ""}
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] text-teal">My videos</div>
            <h1 className="truncate font-[family-name:var(--font-display)] text-2xl text-cream md:text-3xl">
              {identity?.name ?? "…"}
            </h1>
          </div>
        </div>

        <p className="border-l-4 border-mustard bg-black/40 px-3 py-2 text-xs leading-relaxed text-cream/70">
          Your history is tied to this browser. Clearing site data or switching
          devices starts a fresh identity with an empty list.
        </p>

        {load.state === "loading" && (
          <div className="text-xs font-bold tracking-[0.2em] text-mustard">
            <span className="blink">●</span> TUNING IN…
          </div>
        )}

        {load.state === "error" && (
          <div className="border-2 border-danger bg-black/60 px-4 py-3 text-sm text-danger">
            Lost the signal loading your history. Refresh to try again.
          </div>
        )}

        {load.state === "ready" && load.pending.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.3em] text-teal">
              In the works
            </h2>
            <ul className="flex flex-col gap-2">
              {load.pending.map((job) => (
                <li
                  key={job.jobId}
                  className="flex flex-col gap-1 border-2 border-cream/20 bg-panel px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words text-sm text-cream">{job.title}</span>
                    <span
                      className={`shrink-0 text-[10px] font-bold tracking-[0.16em] ${
                        job.status === "failed" ? "text-danger" : "text-mustard"
                      }`}
                    >
                      {STATUS_LABEL[job.status] ?? job.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-xs text-cream/50">
                    {fmtDate(job.createdAt)}
                    {job.duration ? ` · ${job.duration}s` : ""}
                    {job.error ? ` · ${job.error}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {load.state === "ready" && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.3em] text-teal">
              Aired
            </h2>
            {load.videos.length === 0 ? (
              <div className="flex flex-col items-start gap-3 border-2 border-dashed border-cream/30 px-4 py-6">
                <div className="font-[family-name:var(--font-display)] text-lg text-mustard">
                  NOTHING ON THE TAPE YET
                </div>
                <p className="text-sm text-cream/70">
                  Cartoons you add to the stream from this browser will show up
                  here so you can find them again.
                </p>
                <Link
                  href="/"
                  className="rounded-sm border-2 border-orange bg-orange px-4 py-2 font-[family-name:var(--font-display)] text-sm text-void hover:border-mustard hover:bg-mustard"
                >
                  ADD TO STREAM
                </Link>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {load.videos.map((video) => (
                  <li
                    key={video.id}
                    className="flex items-center gap-3 border-l-8 border-orange bg-panel px-4 py-3"
                  >
                    <Link href={video.permalink} className="group min-w-0 flex-1">
                      <div className="truncate font-[family-name:var(--font-display)] text-base text-cream group-hover:text-teal">
                        {video.title}
                      </div>
                      <div className="text-xs text-cream/60">
                        {fmtDate(video.airAt || video.createdAt)} · {fmtLength(video.duration)}
                      </div>
                    </Link>
                    <ShareButton clipId={video.id} title={video.title} className="shrink-0" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtLength(seconds: number): string {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}
