import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { config, mockMode } from "./config";

/** Standards & Practices: a TypeSafe Jev classifier that gates viewer pitches
 * before the writers' room (Claude) spends a token on them. Each policy line
 * is its own yes/no question, all answered in one parallel request; any
 * answer at or above the threshold rejects the pitch. */

export interface ModerationVerdict {
  allowed: boolean;
  /** Shown to the submitter when rejected; empty when allowed. */
  reason: string;
  /** Probability of a violation per policy check (empty in mock mode). */
  scores: Partial<Record<PolicyCheck, number>>;
}

const CHANNEL =
  "INFINITE, an endless AI cartoon channel that pokes fun at bitcoin, freedom tech, and AI. " +
  "The comedy target is ideas, hype cycles, and absurd situations. Light, playful roasting " +
  "and cartoon slapstick are on-brand.";

/** One question per line of the old Claude moderation prompt. The channel
 * description rides along in state so each judgment knows what counts as
 * fair game here. */
const POLICY = {
  hateful: noul(
    "Does `pitch` demean, stereotype, or attack people based on race, ethnicity, religion, gender, sexual orientation, disability, or nationality?",
    {
      true: "Hateful or bigoted content, slurs, or jokes whose punchline is a protected group",
      false: "No group is demeaned for who they are",
    },
  ),
  cruel: noul(
    "Is `pitch` mean-spirited cruelty or harassment aimed at a real, specific person, rather than playful roasting of ideas, hype, products, or public behavior?",
    {
      true: "Humiliates, degrades, threatens, or wishes harm on a real individual",
      false: "Light roasting, fictional characters, or jokes about ideas and trends",
    },
  ),
  private_person: noul(
    "Does `pitch` target a private individual (a named or identifiable person who is not a public figure)?",
    {
      true: "Names or identifies a non-public person, such as a coworker, ex, neighbor, or classmate",
      false: "Only public figures, fictional characters, groups, or nobody in particular",
    },
  ),
  sexual: noul("Does `pitch` ask for sexual or sexually suggestive content?", {
    true: "Nudity, sex acts, fetish content, or sexualized characters",
    false: "Nothing sexual",
  }),
  gore: noul("Does `pitch` ask for graphic violence or gore?", {
    true: "Blood, mutilation, realistic killing, torture, or lingering on serious injury",
    false: "No violence, or harmless cartoon slapstick where nobody is really hurt",
  }),
  illegal: noul(
    "Does `pitch` promote, glorify, or give instructions for real-world illegal activity?",
    {
      true: "Encourages or explains real crimes such as fraud, scams, drug dealing, weapons, or hacking a real target",
      false: "No crime, or an obviously fictional cartoon caper played for laughs",
    },
  ),
};

type PolicyCheck = keyof typeof POLICY;

const REJECTIONS: Record<PolicyCheck, string> = {
  hateful: "Standards & Practices says: punch at ideas, not at who people are.",
  cruel: "Standards & Practices says: roast the hype, not the human.",
  private_person: "Standards & Practices says: leave private folks out of the cartoon.",
  sexual: "Standards & Practices says: this is a family-ish cartoon, champ.",
  gore: "Standards & Practices says: keep the violence at anvil-on-the-head levels.",
  illegal: "Standards & Practices says: no real-world crime tutorials on air.",
};

let client: TypeSafeClient | null = null;
function getClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient({ apiKey: config.typesafe.apiKey });
  return client;
}

export async function moderateIdea(
  idea: string,
  signal?: AbortSignal,
): Promise<ModerationVerdict> {
  if (!config.typesafe.apiKey) {
    // Fully keyless local dev keeps the canned blocklist. Anywhere Claude is
    // live, a missing classifier key must not wave pitches through.
    if (mockMode.llm) return mockModerate(idea);
    throw new Error("TYPESAFE_API_KEY is not set; cannot moderate submissions");
  }

  const { answers } = await getClient().systemOne(
    {
      model: config.typesafe.model,
      state: { channel: CHANNEL, pitch: idea },
      questions: POLICY,
    },
    signal ? { signal } : undefined,
  );

  const scores: Partial<Record<PolicyCheck, number>> = {};
  let worst: PolicyCheck | null = null;
  for (const check of Object.keys(POLICY) as PolicyCheck[]) {
    const p = answers[check].noul;
    scores[check] = p;
    if (p >= config.typesafe.threshold && (!worst || p > scores[worst]!)) {
      worst = check;
    }
  }
  if (worst) {
    console.log(`moderation rejected (${worst}=${scores[worst]!.toFixed(2)}):`, idea);
  }
  return {
    allowed: worst === null,
    reason: worst ? REJECTIONS[worst] : "",
    scores,
  };
}

// ---------- mock fallback (no API keys at all) ----------

const BLOCKLIST = ["kill", "murder", "nazi", "rape", "porn", "sex", "gore"];

function mockModerate(idea: string): ModerationVerdict {
  const lower = idea.toLowerCase();
  const blocked = BLOCKLIST.some((w) => lower.includes(w));
  return {
    allowed: !blocked,
    reason: blocked ? "Standards & Practices says: keep it playful, champ." : "",
    scores: {},
  };
}
