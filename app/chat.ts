import { finalizeEvent, type Event } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { nameForPubkey } from "@/lib/names";
import { ATLBITLAB_HEX, SITE_URL, getSecretKey } from "./identity";

/** Live chat rides on nostr. Messages are NIP-53 live-activity chat events
 * (kind 1311, the kind zap.stream uses) tagged with the station's room
 * address, signed by the per-browser identity from ./identity and read
 * straight from public relays — no server in the loop.
 *
 * Trust model: a chat event proves only that one key signed some text. It
 * never carries approval, price, payment state or a job id. "Fund it" just
 * copies the text into the ordinary submission flow, which creates a fresh
 * server-owned job, re-runs moderation and prices it from scratch. */

export const CHAT_KIND = 1311;
export const CHAT_MAX_LEN = 280;
/** Local send throttle. Relays don't enforce one for us. */
export const CHAT_MIN_INTERVAL_MS = 3_000;
/** Newest messages kept in memory/rendered. Older ones fall off. */
export const CHAT_WINDOW = 150;
/** Relays verified to accept kind 1311 and answer `#a` filters
 * (2026-09-02). nos.lol and relay.nostr.band reject the kind, so the chat
 * uses its own list rather than the purchase-note RELAYS. */
export const CHAT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];
const MUTED_KEY = "infinite_chat_muted";
const PROFILE_BATCH_MS = 1_000;

/** Feature flag: NEXT_PUBLIC_CHAT_ENABLED=1 at build time, or `?chat=1` on
 * any URL so a preview deployment can be exercised without an env change. */
export function chatEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const flag = process.env.NEXT_PUBLIC_CHAT_ENABLED ?? "";
  if (flag === "1" || flag.toLowerCase() === "true") return true;
  return new URLSearchParams(window.location.search).get("chat") === "1";
}

/** The room every message is bound to: a NIP-53 live-event address owned by
 * the ATL BitLab key. Non-production hosts chat in a separate dev room so
 * local testing never lands on the live stream's wall. Publishing a kind
 * 30311 event with `d=infinite` from the ATL BitLab key would make this chat
 * show up in zap.stream-style clients too. */
export function chatRoomAddress(): string {
  const prod = location.hostname === new URL(SITE_URL).hostname;
  return `30311:${ATLBITLAB_HEX}:${prod ? "infinite" : "infinite-dev"}`;
}

export interface ChatMessage {
  id: string;
  pubkey: string;
  text: string;
  /** Unix seconds, as signed by the author (untrusted, display only). */
  at: number;
}

export interface SendResult {
  event: Event;
  /** Relays that acknowledged the event. 0 means nobody else will see it. */
  accepted: number;
  total: number;
}

export interface ChatHandlers {
  onMessage(message: ChatMessage): void;
  /** A kind-0 profile name for a pubkey we've seen chat (real nostr users). */
  onName(pubkey: string, name: string): void;
  onRelays(connected: number): void;
}

export interface ChatConnection {
  send(text: string): Promise<SendResult>;
  close(): void;
}

function acceptable(ev: Event, addr: string): ChatMessage | null {
  const text = ev.content.trim();
  if (!text || text.length > CHAT_MAX_LEN * 2) return null;
  if (ev.created_at > Date.now() / 1000 + 600) return null;
  if (!ev.tags.some((t) => t[0] === "a" && t[1] === addr)) return null;
  return { id: ev.id, pubkey: ev.pubkey, text, at: ev.created_at };
}

/** Subscribe to the room. Dedupes by event id (relays overlap and replay),
 * tolerates out-of-order delivery (the panel sorts), and reconnects with
 * backoff via nostr-tools. */
export function openChat(handlers: ChatHandlers): ChatConnection {
  const addr = chatRoomAddress();
  const seen = new Set<string>();
  const connected = new Set<string>();
  const pool = new SimplePool({ enableReconnect: true, enablePing: true });
  // SimplePool exposes no connection callbacks; poll its status map instead.
  const statusTimer = setInterval(() => {
    let n = 0;
    for (const [url, ok] of pool.listConnectionStatus()) {
      if (ok) connected.add(url);
      else connected.delete(url);
      if (ok) n++;
    }
    handlers.onRelays(n);
  }, 2_000);

  // Look up display names for authors in small batches.
  const known = new Set<string>();
  let pendingProfiles: string[] = [];
  let profileTimer: ReturnType<typeof setTimeout> | undefined;
  function wantProfile(pubkey: string) {
    if (known.has(pubkey)) return;
    known.add(pubkey);
    pendingProfiles.push(pubkey);
    if (profileTimer) return;
    profileTimer = setTimeout(() => {
      profileTimer = undefined;
      const authors = pendingProfiles;
      pendingProfiles = [];
      pool.subscribeManyEose(
        CHAT_RELAYS,
        { kinds: [0], authors },
        {
          maxWait: 4_000,
          onevent(ev) {
            try {
              const p = JSON.parse(ev.content) as {
                display_name?: unknown;
                name?: unknown;
              };
              const raw = [p.display_name, p.name].find(
                (v) => typeof v === "string" && v.trim(),
              ) as string | undefined;
              if (raw) handlers.onName(ev.pubkey, raw.trim().slice(0, 32));
            } catch {
              // not JSON — ignore
            }
          },
        },
      );
    }, PROFILE_BATCH_MS);
  }

  function deliver(ev: Event) {
    if (seen.has(ev.id)) return;
    const msg = acceptable(ev, addr);
    if (!msg) return;
    seen.add(ev.id);
    handlers.onMessage(msg);
    wantProfile(ev.pubkey);
  }

  const sub = pool.subscribeMany(
    CHAT_RELAYS,
    { kinds: [CHAT_KIND], "#a": [addr], limit: CHAT_WINDOW },
    { onevent: deliver },
  );

  let lastSent = 0;
  async function send(input: string): Promise<SendResult> {
    const text = input.trim().slice(0, CHAT_MAX_LEN);
    if (!text) throw new Error("Say something first.");
    const wait = CHAT_MIN_INTERVAL_MS - (Date.now() - lastSent);
    if (wait > 0) throw new Error(`Easy — one message every ${CHAT_MIN_INTERVAL_MS / 1000}s.`);
    lastSent = Date.now();
    const event = finalizeEvent(
      {
        kind: CHAT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["a", addr, CHAT_RELAYS[0], "root"]],
        content: text,
      },
      getSecretKey(),
    );
    // Echo locally right away; the relay copy dedupes on id.
    deliver(event);
    const results = await Promise.allSettled(pool.publish(CHAT_RELAYS, event));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    return { event, accepted, total: CHAT_RELAYS.length };
  }

  return {
    send,
    close() {
      if (profileTimer) clearTimeout(profileTimer);
      clearInterval(statusTimer);
      sub.close();
      pool.close(CHAT_RELAYS);
    },
  };
}

/** One-off post from a short-lived pool (e.g. "funded X" after checkout).
 * Fire-and-forget; never affects the purchase flow. */
export function postChatOnce(text: string): void {
  try {
    const event = finalizeEvent(
      {
        kind: CHAT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["a", chatRoomAddress(), CHAT_RELAYS[0], "root"]],
        content: text.slice(0, CHAT_MAX_LEN),
      },
      getSecretKey(),
    );
    const pool = new SimplePool();
    Promise.allSettled(pool.publish(CHAT_RELAYS, event)).finally(() => {
      pool.close(CHAT_RELAYS);
    });
  } catch (err) {
    console.warn("chat post skipped:", err);
  }
}

export function displayName(pubkey: string, names: Record<string, string>): string {
  return names[pubkey] ?? nameForPubkey(pubkey);
}

export function loadMuted(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveMuted(muted: Set<string>): void {
  try {
    localStorage.setItem(MUTED_KEY, JSON.stringify([...muted]));
  } catch {
    // storage unavailable — mute lasts for this page only
  }
}
