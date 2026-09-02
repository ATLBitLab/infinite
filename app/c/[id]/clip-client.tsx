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
    <main className="relative h-dvh w-dvw overflow-hidden bg-void">
      <div className="scanlines absolute inset-0" onClick={() => !soundOn && setSound(true)}>
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
          <div className="pointer-events-none absolute bottom-28 left-1/2 -translate-x-1/2 rounded-sm border-2 border-mustard bg-black/75 px-4 py-2 text-xs font-bold tracking-[0.2em] text-mustard">
            🔇 TAP FOR SOUND
          </div>
        )}
      </div>

      {/* ---- top bar ---- */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="font-[family-name:var(--font-display)] text-2xl leading-none text-mustard drop-shadow-[3px_3px_0_#e63946]"
          >
            INFINITE
          </Link>
          <span className="rounded-sm border-2 border-teal bg-black/60 px-2 py-0.5 text-xs font-bold tracking-widest text-teal">
            REPLAY
          </span>
        </div>
        <div className="flex items-center gap-3">
          <ShareButton clipId={clip.id} title={clip.title} />
          <button
            onClick={() => setSound(!soundOn)}
            className="rounded-sm border-2 border-cream/60 bg-black/60 px-3 py-1 text-xs font-bold tracking-widest hover:border-teal hover:text-teal"
          >
            {soundOn ? "SOUND: ON" : "SOUND: OFF"}
          </button>
        </div>
      </div>

      {/* ---- lower third ---- */}
      <div className="pointer-events-none absolute bottom-20 left-4 max-w-[80vw] border-l-4 border-orange bg-black/70 px-4 py-2 md:bottom-24">
        <div className="text-[10px] uppercase tracking-[0.3em] text-teal">
          From the archive
        </div>
        <div className="font-[family-name:var(--font-display)] text-lg text-cream">
          {clip.title}
        </div>
        <div className="text-xs opacity-70">{credit}</div>
      </div>

      {/* ---- bottom bar ---- */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-3 border-t-4 border-mustard bg-panel px-4 py-3">
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
