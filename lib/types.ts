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
  /** Requested amount. Persisted before invoice creation so webhook updates
   * can complete the job without relying on the Payments API read model. */
  sats?: number;
  /** Purchased clip length in seconds. Absent = default max single length. */
  duration?: number;
  /** One prompt per scene for multi-scene episodes (chained renders). */
  scenePrompts?: string[];
  /** Seconds per scene, parallel to scenePrompts. */
  segmentDurations?: number[];
  /** BOLT11 populated by the receive.generated webhook (or reconciliation). */
  bolt11?: string;
  clipId?: string;
  error?: string;
  /** Failed generation attempts so far (job stays retryable until capped). */
  retries?: number;
  createdAt: number;
}

export interface ViewerSample {
  id: string;
  name: string;
}

export interface ActivityItem {
  id: string;
  type: "submission";
  name: string;
  title: string;
  ts: number;
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
