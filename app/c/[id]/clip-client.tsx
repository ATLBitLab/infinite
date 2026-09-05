"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { Clip } from "@/lib/types";
import ShareButton from "../../share-button";

/** Permalink player for one clip. Loops the cartoon, credits it, and points
 * back at the live broadcast. Deliberately does not poll /api/now. */
export default function ClipClient({
  clip,
  credit,
}: {
  clip: Clip;
  credit: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [soundOn, setSoundOn] = useState(false);

  const setSound = useCallback((on: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !on;
    setSoundOn(on);
    video.play().catch(() => {
      video.muted = true;
      setSoundOn(false);
      video.play().catch(() => {});
    });
  }, []);

  return (
    <main className="relative flex h-dvh w-dvw flex-col overflow-hidden bg-void md:block">
      {/* ---- top bar ---- */}
      <div className="relative z-10 flex shrink-0 items-center justify-between gap-2 px-3 py-2 md:absolute md:inset-x-0 md:top-0 md:p-4">
        <div className="flex items-center gap-2 md:gap-3">
          <Link
            href="/"
            className="font-[family-name:var(--font-display)] text-xl leading-none text-mustard drop-shadow-[3px_3px_0_#e63946] md:text-2xl"
          >
            INFINITE
          </Link>
          <span className="whitespace-nowrap rounded-sm border-2 border-teal bg-black/60 px-2 py-0.5 text-xs font-bold tracking-widest text-teal">
            REPLAY
          </span>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <ShareButton clipId={clip.id} title={clip.title} />
          <button
            onClick={() => setSound(!soundOn)}
            aria-label={soundOn ? "Turn sound off" : "Turn sound on"}
            className="whitespace-nowrap rounded-sm border-2 border-cream/60 bg-black/60 px-3 py-1 text-xs font-bold tracking-widest hover:border-teal hover:text-teal"
          >
            <span className="md:hidden">{soundOn ? "🔊 ON" : "🔇 OFF"}</span>
            <span className="hidden md:inline">
              {soundOn ? "SOUND: ON" : "SOUND: OFF"}
            </span>
          </button>
        </div>
      </div>

      {/* ---- player ---- */}
      <div
        className="scanlines relative aspect-video w-full shrink-0 md:absolute md:inset-0 md:aspect-auto"
        onClick={() => !soundOn && setSound(true)}
      >
        <video
          ref={videoRef}
          src={clip.videoUrl}
          autoPlay
          loop
          muted
          playsInline
          className="h-full w-full object-contain"
        />
        {!soundOn && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-sm border-2 border-mustard bg-black/75 px-4 py-2 text-xs font-bold tracking-[0.2em] text-mustard">
              🔇 TAP FOR SOUND
            </div>
          </div>
        )}
      </div>

      {/* ---- lower third ---- */}
      <div className="pointer-events-none min-h-0 flex-1 px-3 pt-3 md:absolute md:bottom-24 md:left-4 md:flex-none md:p-0">
        <div className="w-fit max-w-full border-l-4 border-orange bg-black/70 px-4 py-2 md:max-w-[80vw]">
          <div className="text-[10px] uppercase tracking-[0.3em] text-teal">
            From the archive
          </div>
          <div className="font-[family-name:var(--font-display)] text-base text-cream md:text-lg">
            {clip.title}
          </div>
          <div className="text-xs opacity-70">{credit}</div>
        </div>
      </div>

      {/* ---- bottom bar ---- */}
      <div className="flex shrink-0 items-center gap-3 border-t-4 border-mustard bg-panel px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:absolute md:inset-x-0 md:bottom-0 md:px-4">
        <Link
          href="/"
          className="shrink-0 rounded-sm border-2 border-orange bg-orange px-4 py-2 font-[family-name:var(--font-display)] text-sm text-void hover:border-mustard hover:bg-mustard"
        >
          ● WATCH LIVE
        </Link>
        <div className="truncate text-sm text-teal">
          This is a rerun. The live channel never stops — new cartoons air all day, and yours can be next.
        </div>
      </div>
    </main>
  );
}
