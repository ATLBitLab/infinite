import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("bad key hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Frictionless per-browser nostr identity (MVP):
 * a keypair is generated on first visit and kept in localStorage; the display
 * name ("floppy wombat") and avatar hue derive deterministically from the
 * pubkey. Later this can upgrade to real nostr login (NIP-07). */

const SK_KEY = "infinite_nostr_sk";
export const SITE_URL = "https://infinite.atlbitlab.com";

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

const ADJECTIVES = [
  "floppy", "sneaky", "turbo", "sleepy", "spicy", "wobbly", "cosmic", "grumpy",
  "shiny", "feral", "dapper", "soggy", "zesty", "mellow", "rowdy", "crispy",
  "gnarly", "plucky", "fuzzy", "jazzy", "salty", "breezy", "chunky", "nimble",
  "quirky", "rusty", "snappy", "velvet", "wired", "bouncy", "smug", "electric",
];

const ANIMALS = [
  "wombat", "pelican", "ferret", "walrus", "gecko", "badger", "heron", "otter",
  "possum", "iguana", "marmot", "toucan", "lemur", "narwhal", "beaver", "falcon",
  "mongoose", "tapir", "puffin", "axolotl", "capybara", "stoat", "ibex", "quokka",
  "raccoon", "newt", "osprey", "armadillo", "shrew", "kestrel", "yak", "dingo",
];

export interface Identity {
  pubkey: string;
  /** First 16 hex chars — the presence id sent on heartbeats. */
  shortId: string;
  name: string;
}

function hashHex(hex: string): number {
  let h = 2166136261;
  for (let i = 0; i < hex.length; i++) {
    h ^= hex.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function nameForPubkey(pubkey: string): string {
  const h = hashHex(pubkey);
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >> 8) % ANIMALS.length]}`;
}

export function hueForId(id: string): number {
  return hashHex(id) % 360;
}

function getSecretKey(): Uint8Array {
  const stored = localStorage.getItem(SK_KEY);
  if (stored) {
    try {
      return hexToBytes(stored);
    } catch {
      // corrupted — regenerate below
    }
  }
  const sk = generateSecretKey();
  localStorage.setItem(SK_KEY, bytesToHex(sk));
  return sk;
}

/** Load (or mint) this browser's identity. Client-side only. */
export function loadIdentity(): Identity {
  const sk = getSecretKey();
  const pubkey = getPublicKey(sk);
  return { pubkey, shortId: pubkey.slice(0, 16), name: nameForPubkey(pubkey) };
}

/** Broadcast the purchase as a signed kind-1 note. Fire-and-forget: relay
 * failures never affect the purchase flow. */
export function broadcastPurchase(title: string): void {
  try {
    // Don't spam public relays from localhost/preview deployments.
    if (location.hostname !== new URL(SITE_URL).hostname) {
      console.log("nostr broadcast skipped (not production host)");
      return;
    }
    const sk = getSecretKey();
    const event = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["r", SITE_URL]],
        content: `Just added "${title}" to INFINITE — the endless AI cartoon channel 📺⚡ ${SITE_URL}`,
      },
      sk,
    );
    const pool = new SimplePool();
    Promise.allSettled(pool.publish(RELAYS, event)).finally(() => {
      pool.close(RELAYS);
    });
  } catch (err) {
    console.warn("nostr broadcast skipped:", err);
  }
}
