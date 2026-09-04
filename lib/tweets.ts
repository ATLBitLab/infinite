import { config } from "./config";

/** Tweet clippings: when a viewer pastes an x.com / twitter.com link in their
 * idea, the writers' room fetches that post plus the chain of posts it replies
 * to, so the sketch can riff on the actual conversation. No X API key is
 * needed: we read the same public embed JSON X serves to its own widgets,
 * via api.fxtwitter.com (friendlier shape) with the syndication CDN as a
 * fallback. Both are unofficial; every failure degrades to "no clipping"
 * rather than blocking the submission. */

export interface TweetPost {
  id: string;
  url: string;
  authorName: string;
  authorHandle: string;
  text: string;
  createdAt?: string;
  /** Post this one quotes, when any. One level only. */
  quoted?: { authorHandle: string; text: string };
  hasMedia: boolean;
}

export interface TweetClipping {
  /** The link as the viewer pasted it. */
  url: string;
  /** Oldest first; the linked post is always the last entry. */
  chain: TweetPost[];
  /** True when the thread continues above the hop cap. */
  truncated: boolean;
}

const STATUS_URL_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com)\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/(\d{1,25})/gi;

const HOP_TIMEOUT_MS = 4_000;
const MAX_TEXT_CHARS = 600;

/** Every X status link in the text, in order, deduplicated by post id. */
export function extractTweetUrls(text: string): { url: string; id: string }[] {
  const seen = new Set<string>();
  const out: { url: string; id: string }[] = [];
  for (const m of text.matchAll(STATUS_URL_RE)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ url: m[0], id });
  }
  return out;
}

/** Fetch the linked post and walk its reply-to parents, at most
 * `config.tweetMaxHops` of them. Returns null when clippings are disabled,
 * the link is not an X status, or the linked post itself cannot be fetched;
 * a failure further up the thread keeps what was gathered and marks it
 * truncated. */
export async function fetchTweetClipping(
  url: string,
  signal?: AbortSignal,
): Promise<TweetClipping | null> {
  if (!config.tweetContext) return null;
  const id = extractTweetUrls(url)[0]?.id;
  if (!id) return null;

  const target = await fetchPost(id, signal);
  if (!target) return null;

  const chain: TweetPost[] = [target.post];
  const seen = new Set([id]);
  let parentId = target.parentId;
  let truncated = false;
  while (parentId) {
    if (chain.length > config.tweetMaxHops || signal?.aborted || seen.has(parentId)) {
      truncated = true;
      break;
    }
    seen.add(parentId);
    const parent = await fetchPost(parentId, signal);
    if (!parent) {
      truncated = true;
      break;
    }
    chain.unshift(parent.post);
    parentId = parent.parentId;
  }
  return { url, chain, truncated };
}

/** Load the first X link in an idea. Never throws. */
export async function clippingForIdea(
  idea: string,
  signal?: AbortSignal,
): Promise<TweetClipping | null> {
  const first = extractTweetUrls(idea)[0];
  if (!first) return null;
  try {
    return await fetchTweetClipping(first.url, signal);
  } catch (err) {
    console.warn("tweet clipping failed, writing without it:", err);
    return null;
  }
}

/** Plain-text block handed to the writers' room. */
export function formatClipping(c: TweetClipping): string {
  const lines: string[] = [];
  if (c.truncated) lines.push("[earlier posts in this thread omitted]");
  c.chain.forEach((p, i) => {
    const last = i === c.chain.length - 1;
    const when = p.createdAt ? ` (${p.createdAt.slice(0, 10)})` : "";
    const tag = last ? "LINKED POST" : `${i + 1}`;
    lines.push(`[${tag}] @${p.authorHandle} (${p.authorName})${when}: ${p.text}${p.hasMedia ? " (attached media not shown)" : ""}`);
    if (p.quoted) lines.push(`    quoting @${p.quoted.authorHandle}: ${p.quoted.text}`);
  });
  return lines.join("\n");
}

interface Fetched {
  post: TweetPost;
  parentId: string | null;
}

async function fetchPost(id: string, signal?: AbortSignal): Promise<Fetched | null> {
  return (await fetchFx(id, signal)) ?? (await fetchSyndication(id, signal));
}

function hopSignal(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(HOP_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function clean(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

async function fetchFx(id: string, signal?: AbortSignal): Promise<Fetched | null> {
  try {
    const res = await fetch(`https://api.fxtwitter.com/i/status/${id}`, {
      signal: hopSignal(signal),
      headers: { "user-agent": "infinite-writers-room/1.0" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: number;
      tweet?: {
        id?: string;
        url?: string;
        text?: string;
        created_at?: string;
        author?: { name?: string; screen_name?: string };
        replying_to_status?: string | null;
        quote?: { text?: string; author?: { screen_name?: string } } | null;
        media?: unknown;
      };
    };
    const t = data.tweet;
    if (data.code !== 200 || !t?.author?.screen_name) return null;
    return {
      post: {
        id: String(t.id ?? id),
        url: t.url ?? `https://x.com/${t.author.screen_name}/status/${id}`,
        authorName: clean(t.author.name) || t.author.screen_name,
        authorHandle: t.author.screen_name,
        text: clean(t.text),
        createdAt: isoDate(t.created_at),
        quoted: t.quote?.author?.screen_name
          ? { authorHandle: t.quote.author.screen_name, text: clean(t.quote.text) }
          : undefined,
        hasMedia: Boolean(t.media),
      },
      parentId: t.replying_to_status ? String(t.replying_to_status) : null,
    };
  } catch {
    return null;
  }
}

async function fetchSyndication(id: string, signal?: AbortSignal): Promise<Fetched | null> {
  try {
    const res = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=x`,
      { signal: hopSignal(signal), headers: { "user-agent": "infinite-writers-room/1.0" } },
    );
    if (!res.ok) return null;
    const d = (await res.json()) as {
      id_str?: string;
      text?: string;
      created_at?: string;
      user?: { name?: string; screen_name?: string };
      parent?: { id_str?: string };
      in_reply_to_status_id_str?: string;
      quoted_tweet?: { text?: string; user?: { screen_name?: string } };
      mediaDetails?: unknown[];
    };
    if (!d.user?.screen_name) return null;
    const parent = d.parent?.id_str ?? d.in_reply_to_status_id_str ?? null;
    return {
      post: {
        id: String(d.id_str ?? id),
        url: `https://x.com/${d.user.screen_name}/status/${id}`,
        authorName: clean(d.user.name) || d.user.screen_name,
        authorHandle: d.user.screen_name,
        text: clean(d.text),
        createdAt: isoDate(d.created_at),
        quoted: d.quoted_tweet?.user?.screen_name
          ? { authorHandle: d.quoted_tweet.user.screen_name, text: clean(d.quoted_tweet.text) }
          : undefined,
        hasMedia: Array.isArray(d.mediaDetails) && d.mediaDetails.length > 0,
      },
      parentId: parent ? String(parent) : null,
    };
  } catch {
    return null;
  }
}

function isoDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
