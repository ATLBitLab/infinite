import { AwsClient } from "aws4fetch";
import { config } from "./config";

/** Clip archive on Cloudflare R2 (S3 API via SigV4).
 *
 * fal serves renders from its CDN with a configurable retention and no
 * documented default, and Redis only stores the URL, so a finished mp4 is
 * copied into our own bucket before the clip is scheduled. Archiving is best
 * effort: if R2 is unset or the copy fails, the clip airs from fal as before
 * and the backfill route (/api/cron/archive-clips) picks it up later. */

export function storageEnabled(): boolean {
  const r = config.r2;
  return Boolean(r.accountId && r.accessKeyId && r.secretAccessKey && r.bucket && r.publicUrl);
}

export function isArchivedUrl(url: string): boolean {
  return storageEnabled() && url.startsWith(`${config.r2.publicUrl}/`);
}

export function clipObjectKey(clipId: string): string {
  return `clips/${clipId}.mp4`;
}

const FETCH_TIMEOUT_MS = 60_000;

let client: AwsClient | null = null;
function s3(): AwsClient {
  client ??= new AwsClient({
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  return client;
}

/** Copy the video at sourceUrl into the bucket and return its public URL.
 * Throws on failure; callers that must not block on it use archiveOrKeep. */
export async function archiveClipVideo(clipId: string, sourceUrl: string): Promise<string> {
  if (!storageEnabled() || isArchivedUrl(sourceUrl)) return sourceUrl;

  const source = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!source.ok) throw new Error(`source fetch failed: HTTP ${source.status}`);
  const body = await source.arrayBuffer();
  if (body.byteLength === 0) throw new Error("source is empty");

  const key = clipObjectKey(clipId);
  const { accountId, bucket, publicUrl } = config.r2;
  const put = await s3().fetch(
    `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`,
    {
      method: "PUT",
      body,
      headers: {
        "content-type": source.headers.get("content-type") ?? "video/mp4",
        "content-length": String(body.byteLength),
        // R2 accepts unsigned payloads; skip hashing 25+ MB in the function.
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!put.ok) {
    throw new Error(`R2 PUT failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  }
  return `${publicUrl}/${key}`;
}

/** Archive, or fall back to the fal URL so a copy failure never costs the
 * viewer their episode. Returns [videoUrl, sourceUrl]. */
export async function archiveOrKeep(
  clipId: string,
  sourceUrl: string,
): Promise<{ videoUrl: string; sourceUrl: string }> {
  try {
    return { videoUrl: await archiveClipVideo(clipId, sourceUrl), sourceUrl };
  } catch (err) {
    console.error(`clip ${clipId} archive failed, serving from fal:`, err);
    return { videoUrl: sourceUrl, sourceUrl };
  }
}
