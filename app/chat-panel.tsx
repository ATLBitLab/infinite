"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hueForId, type Identity } from "./identity";
import {
  CHAT_MAX_LEN,
  CHAT_WINDOW,
  displayName,
  loadMuted,
  openChat,
  saveMuted,
  type ChatConnection,
  type ChatMessage,
} from "./chat";

export interface ChatAuthor {
  pubkey: string;
  name: string;
}

export default function ChatPanel({
  identity,
  onFund,
  fundDisabled,
}: {
  identity: Identity;
  onFund: (text: string, author: ChatAuthor) => void;
  fundDisabled: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const [relays, setRelays] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conn = useRef<ChatConnection | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    setMuted(loadMuted());
    const c = openChat({
      onMessage(m) {
        setMessages((prev) => {
          const next = [...prev, m].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
          return next.length > CHAT_WINDOW ? next.slice(-CHAT_WINDOW) : next;
        });
      },
      onName(pubkey, name) {
        setNames((prev) => (prev[pubkey] === name ? prev : { ...prev, [pubkey]: name }));
      },
      onRelays: setRelays,
    });
    conn.current = c;
    return () => {
      c.close();
      conn.current = null;
    };
  }, []);

  // Follow new messages unless the reader scrolled up to look at history.
  useEffect(() => {
    const el = list.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = list.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const c = conn.current;
    if (!c || sending || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await c.send(draft);
      setDraft("");
      if (res.accepted === 0) {
        setError("No relay took that one. It's on your screen only — try again in a sec.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  function mute(pubkey: string) {
    const next = new Set(muted);
    next.add(pubkey);
    saveMuted(next);
    setMuted(next);
  }

  function unmuteAll() {
    const next = new Set<string>();
    saveMuted(next);
    setMuted(next);
  }

  const visible = messages.filter((m) => !muted.has(m.pubkey));

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-1 flex-col border-t-4 border-mustard bg-panel md:w-80 md:flex-none md:border-t-0 md:border-l-4"
      aria-label="Live chat"
    >
      <div className="flex items-center justify-between border-b-2 border-cream/20 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="font-[family-name:var(--font-display)] text-base text-mustard">
            LIVE CHAT
          </span>
          <span
            className={`text-[10px] tracking-widest ${relays > 0 ? "text-teal" : "text-cream/40"}`}
            title={`${relays} nostr relay${relays === 1 ? "" : "s"} connected`}
          >
            {relays > 0 ? "● NOSTR" : "○ CONNECTING"}
          </span>
        </div>
        {muted.size > 0 && (
          <button
            onClick={unmuteAll}
            className="text-[10px] tracking-wider text-cream/50 hover:text-teal"
            title="Clear your mute list"
          >
            {muted.size} MUTED
          </button>
        )}
      </div>

      <div ref={list} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-1">
        {visible.length === 0 && (
          <div className="px-3 py-6 text-center text-sm opacity-60">
            Nobody's yelling at the TV yet. Say something — or pitch a scene and
            let someone else pay for it.
          </div>
        )}
        {visible.map((m) => {
          const mine = m.pubkey === identity.pubkey;
          const name = mine ? identity.name : displayName(m.pubkey, names);
          return (
            <div key={m.id} className="group flex gap-2 px-3 py-1.5 text-sm hover:bg-black/30">
              <span
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-void text-[9px] font-bold text-void"
                style={{ backgroundColor: `hsl(${hueForId(m.pubkey.slice(0, 16))} 70% 60%)` }}
                title={m.pubkey}
              >
                {initials(name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={`truncate text-xs font-bold ${mine ? "text-teal" : "text-mustard"}`}>
                    {mine ? "you" : name}
                  </span>
                  <span className="text-[10px] text-cream/40">{clock(m.at)}</span>
                </div>
                <div className="break-words">{m.text}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <button
                  onClick={() => onFund(m.text, { pubkey: m.pubkey, name })}
                  disabled={fundDisabled}
                  title="Turn this message into a cartoon pitch (AI review + Lightning checkout)"
                  className="border-2 border-orange px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-orange hover:bg-orange hover:text-void disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-orange"
                >
                  ⚡ FUND
                </button>
                {!mine && (
                  <button
                    onClick={() => mute(m.pubkey)}
                    className="text-[10px] text-cream/40 hover:text-danger md:invisible md:group-hover:visible"
                    title="Hide this person on this device"
                  >
                    mute
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={send} className="border-t-2 border-cream/20 p-2">
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={CHAT_MAX_LEN}
            placeholder={`Yell at the TV as ${identity.name}…`}
            aria-label="Chat message"
            className="min-w-0 flex-1 border-2 border-teal/60 bg-void px-2 py-1.5 text-base outline-none focus:border-teal md:text-sm"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="border-2 border-teal px-3 text-xs font-bold tracking-wider text-teal hover:bg-teal hover:text-void disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-teal"
          >
            SEND
          </button>
        </div>
        <div className="mt-1 flex justify-between text-[10px]">
          <span className="text-danger">{error ?? ""}</span>
          {draft.length > CHAT_MAX_LEN - 60 && (
            <span className="text-cream/50">{CHAT_MAX_LEN - draft.length}</span>
          )}
        </div>
      </form>
    </aside>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function clock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
