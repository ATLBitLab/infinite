export type ClipKind = "house" | "paid";

export interface Clip {
  id: string;
  kind: ClipKind;
  /** The raw idea (user-submitted or LLM-generated). */
  idea: string;
  /** Short on-screen title for the ticker. */
  title: string;
  /** The full expanded prompt sent to the video model. */
  videoPrompt: string;
  videoUrl: string;
  /** Duration in seconds. */
  duration: number;
  /** Optional credit line, e.g. a name or npub. */
  credit?: string;
  /** Epoch ms when this clip is scheduled to air. 0 = library-only (rerun pool). */
  airAt: number;
  createdAt: number;
}

export type JobStatus =
  | "awaiting_payment"
  | "paid"
  | "generating"
  | "done"
  | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  idea: string;
  title: string;
  videoPrompt: string;
  credit?: string;
  paymentId?: string;
  clipId?: string;
  error?: string;
  createdAt: number;
}

export interface InvoiceInfo {
  paymentId: string;
  bolt11: string;
  sats: number;
}

export interface NowPlaying {
  clip: Clip | null;
  /** Offset into the clip in ms at serverNow. */
  offsetMs: number;
  /** Whether this is a rerun (nothing freshly scheduled right now). */
  rerun: boolean;
  upNext: Pick<Clip, "id" | "title" | "credit" | "kind">[];
  serverNow: number;
  libraryCount: number;
  /** True when the stream has no content and the client should trigger a house generation. */
  needsBootstrap: boolean;
}
