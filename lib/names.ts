/** Deterministic "floppy wombat" display names. Pure and isomorphic: used by
 * the browser identity (app/identity.ts) and by the server-side credit repair
 * in the store. */

export const ADJECTIVES = [
  "floppy", "sneaky", "turbo", "sleepy", "spicy", "wobbly", "cosmic", "grumpy",
  "shiny", "feral", "dapper", "soggy", "zesty", "mellow", "rowdy", "crispy",
  "gnarly", "plucky", "fuzzy", "jazzy", "salty", "breezy", "chunky", "nimble",
  "quirky", "rusty", "snappy", "velvet", "wired", "bouncy", "smug", "electric",
];

export const ANIMALS = [
  "wombat", "pelican", "ferret", "walrus", "gecko", "badger", "heron", "otter",
  "possum", "iguana", "marmot", "toucan", "lemur", "narwhal", "beaver", "falcon",
  "mongoose", "tapir", "puffin", "axolotl", "capybara", "stoat", "ibex", "quokka",
  "raccoon", "newt", "osprey", "armadillo", "shrew", "kestrel", "yak", "dingo",
];

/** FNV-1a over the string's char codes, as an unsigned 32-bit int. */
export function hashHex(hex: string): number {
  let h = 2166136261;
  for (let i = 0; i < hex.length; i++) {
    h ^= hex.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function nameForPubkey(pubkey: string): string {
  const h = hashHex(pubkey);
  // >>> keeps the shifted hash unsigned; >> can go negative and make the
  // modulo negative, yielding "nimble undefined"-style names.
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 8) % ANIMALS.length]}`;
}

export function hueForId(id: string): number {
  return hashHex(id) % 360;
}

const BROKEN_CREDIT = /^([a-z]+) undefined$/;

/** Repair credits minted by the pre-fix name generator ("grumpy undefined").
 * The browser froze the string into the clip at submit time and the pubkey
 * was never stored, so the original animal is unrecoverable; pick one
 * deterministically from `seed` (the clip/activity id) so it stays stable
 * across renders. Anything that isn't exactly `<adjective> undefined` passes
 * through untouched — a human typing that on purpose keeps it. */
export function repairCredit(credit: string, seed: string): string;
export function repairCredit(credit: string | undefined, seed: string): string | undefined;
export function repairCredit(credit: string | undefined, seed: string): string | undefined {
  if (!credit) return credit;
  const m = BROKEN_CREDIT.exec(credit);
  if (!m || !ADJECTIVES.includes(m[1])) return credit;
  return `${m[1]} ${ANIMALS[hashHex(seed) % ANIMALS.length]}`;
}
