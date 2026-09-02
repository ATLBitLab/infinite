"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Share a permalink to one clip. Uses the native share sheet where the
 * browser has one (phones), otherwise copies the link to the clipboard. */
export default function ShareButton({
  clipId,
  title,
  className = "",
}: {
  clipId: string;
  title: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const share = useCallback(async () => {
    const url = `${window.location.origin}/c/${clipId}`;
    const text = `“${title}” on INFINITE, the endless cartoon channel`;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: text, url });
        return;
      } catch {
        // dismissed or unsupported payload — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }, [clipId, title]);

  return (
    <button
      onClick={share}
      aria-label="Share this cartoon"
      className={`rounded-sm border-2 px-3 py-1 text-xs font-bold tracking-widest transition-colors ${
        copied
          ? "border-mustard bg-mustard text-void"
          : "border-cream/60 bg-black/60 hover:border-teal hover:text-teal"
      } ${className}`}
    >
      {copied ? "LINK COPIED" : "SHARE"}
    </button>
  );
}
