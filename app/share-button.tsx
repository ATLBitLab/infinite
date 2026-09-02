"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Copy a permalink to one clip and confirm with a toast. Deliberately no
 * navigator.share: on Safari the share sheet, its bookmark prompt, and the
 * fallback alert stacked into three steps for what should be one click. */
export default function ShareButton({
  clipId,
  title,
  className = "",
}: {
  clipId: string;
  title: string;
  className?: string;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const show = useCallback((msg: string) => {
    setToast(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const share = useCallback(() => {
    const url = `${window.location.origin}/c/${clipId}`;
    // Call writeText synchronously inside the click so Safari still counts
    // it as user-initiated; only react to the result afterwards.
    const viaApi = navigator.clipboard?.writeText(url);
    if (viaApi) {
      viaApi
        .then(() => show("LINK COPIED TO CLIPBOARD"))
        .catch(() => (legacyCopy(url) ? show("LINK COPIED TO CLIPBOARD") : show(url)));
    } else {
      legacyCopy(url) ? show("LINK COPIED TO CLIPBOARD") : show(url);
    }
  }, [clipId, show]);

  return (
    <>
      <button
        onClick={share}
        aria-label={`Copy a link to “${title}”`}
        className={`rounded-sm border-2 border-cream/60 bg-black/60 px-3 py-1 text-xs font-bold tracking-widest hover:border-teal hover:text-teal ${className}`}
      >
        SHARE
      </button>
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-16 z-50 -translate-x-1/2 whitespace-nowrap rounded-sm border-2 border-mustard bg-black/85 px-4 py-2 text-xs font-bold tracking-[0.2em] text-mustard"
        >
          {toast}
        </div>
      )}
    </>
  );
}

/** Old-school copy for browsers that refuse the async clipboard API. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
