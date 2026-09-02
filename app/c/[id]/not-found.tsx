import Link from "next/link";

export default function ClipNotFound() {
  return (
    <main className="flex h-dvh w-dvw flex-col items-center justify-center gap-4 bg-void p-6 text-center">
      <div className="font-[family-name:var(--font-display)] text-4xl text-mustard drop-shadow-[3px_3px_0_#e63946] md:text-6xl">
        LOST SIGNAL
      </div>
      <p className="max-w-sm text-sm opacity-70">
        That cartoon isn&apos;t in the library. It may have never aired, or the
        link got mangled on the way here.
      </p>
      <Link
        href="/"
        className="rounded-sm border-2 border-orange bg-orange px-4 py-2 font-[family-name:var(--font-display)] text-sm text-void hover:border-mustard hover:bg-mustard"
      >
        WATCH THE LIVE CHANNEL
      </Link>
    </main>
  );
}
