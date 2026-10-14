import { createHash } from "crypto";
import { verifyEvent, type Event } from "nostr-tools/pure";

/** Server-side NIP-98 (HTTP Auth) check. The browser signs a kind-27235
 * event with its per-browser key (app/identity.ts) naming this exact URL and
 * method, and sends it as `Authorization: Nostr <base64 event>`. */

const HTTP_AUTH_KIND = 27235;
// NIP-98 suggests a "reasonable window"; a minute tolerates clock skew
// without making a captured header useful for long.
const MAX_SKEW_SECONDS = 60;
const MAX_TOKEN_BYTES = 4096;

/** The signer's hex pubkey, or null when the header is missing or does not
 * prove this request. When `body` is given, the event must carry a matching
 * `payload` tag (sha256 of the raw body) so the signature covers it. */
export function verifyNip98(request: Request, body?: string): string | null {
  try {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Nostr\s+(\S+)$/i.exec(header);
    if (!match || match[1].length > MAX_TOKEN_BYTES) return null;
    const event = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Event;

    if (event.kind !== HTTP_AUTH_KIND) return null;
    if (Math.abs(Date.now() / 1000 - event.created_at) > MAX_SKEW_SECONDS) return null;
    if (!verifyEvent(event)) return null;

    const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
    if (tag("method")?.toUpperCase() !== request.method.toUpperCase()) return null;
    if (!sameUrl(tag("u"), request)) return null;
    if (body !== undefined && tag("payload") !== sha256Hex(body)) return null;

    return event.pubkey.toLowerCase();
  } catch {
    return null;
  }
}

/** Compare host + path + query. The scheme is ignored: TLS terminates at the
 * edge, so the function can see http:// for a request the browser made (and
 * signed) as https://. */
function sameUrl(signed: string | undefined, request: Request): boolean {
  if (!signed) return false;
  const u = new URL(signed);
  const actual = new URL(request.url);
  const host = (
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? actual.host
  ).split(",")[0].trim();
  return (
    u.host === host &&
    u.pathname === actual.pathname &&
    u.search === actual.search
  );
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
