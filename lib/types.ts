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
  /** Where the player loads the mp4 from: our R2 archive when configured,
   * otherwise the fal CDN URL the render produced. */
  videoUrl: string;
  /** The fal CDN URL the render produced, kept as a fallback once videoUrl
   * points at our own archive. */
  sourceUrl?: string;
  /** Duration in seconds. */
  duration: number;
  /** Optional credit line, e.g. a name or npub. */
  credit?: string;
  /** Epoch ms when this clip is scheduled to air. 0 = library-only (rerun pool). */
  airAt: number;
  createdAt: number;
}

export type JobStatus =
  | "preparing"
  | "rejected"
  | "awaiting_payment"
  | "paid"
  | "generating"
  | "done"
  | "failed";

export type JobRenderer = "fal" | "director";

export type JobFailureStage =
  | "preflight"
  | "invoice"
  | "payment"
  | "generation";

export interface Job {
  id: string;
  status: JobStatus;
  idea: string;
  /** Empty only while the writers' room is preparing the submission. */
  title: string;
  /** Empty only while the writers' room is preparing the submission. */
  videoPrompt: string;
  credit?: string;
  paymentId?: string;
  /** Requested amount. Persisted before invoice creation so webhook updates
   * can complete the job without relying on the Payments API read model. */
  sats?: number;
  /** Purchased clip length in seconds. Absent = default max single length. */
  duration?: number;
  /** Which render path produces the clip. Absent = "fal" (queue API, chained
   * scenes). "director" = one continuous H3 Max Director session, recorded
   * by the recorder worker rather than rendered inside /api/generate. */
  renderer?: JobRenderer;
  /** Director only: the show bible sent as the session's configure prompt.
   * scenePrompts then hold one beat per 10s chunk. */
  directorPremise?: string;
  /** Director only: times a recorder has claimed this job. Counted at claim
   * time (not just on reported failure) because every claim opens a billed
   * live session, and a recorder that crashes never reports back. */
  claimAttempts?: number;
  /** Director only: the recorded mp4, persisted before the clip is
   * scheduled so a retried `complete` cannot air the purchase twice. */
  directorVideoUrl?: string;
  /** One prompt per scene for multi-scene episodes (chained renders). */
  scenePrompts?: string[];
  /** Seconds per scene, parallel to scenePrompts. */
  segmentDurations?: number[];
  /** Rendered scene URLs so far, so a retry resumes instead of re-paying
   * for scenes that already rendered. */
  sceneUrls?: string[];
  /** BOLT11 populated by the receive.generated webhook (or reconciliation). */
  bolt11?: string;
  clipId?: string;
  /** Viewer-facing explanation from standards and practices. */
  moderationReason?: string;
  error?: string;
  failureStage?: JobFailureStage;
  /** Failed or interrupted writers' room attempts. */
  preflightAttempts?: number;
  /** When the complete render prompt crossed the durable payment gate. */
  preparedAt?: number;
  /** Bounded attempts to submit this job's server-generated payment ID. */
  invoiceRequestAttempts?: number;
  invoiceRequestAt?: number;
  /** Lease protecting a paid render from duplicate workers. */
  generationLeaseUntil?: number;
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
