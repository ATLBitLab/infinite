import Anthropic from "@anthropic-ai/sdk";
import { config, mockMode, STYLE_PROMPT } from "./config";

/** LLM layer: idea generation, content moderation, and video-prompt expansion.
 * Falls back to canned behavior when ANTHROPIC_API_KEY is unset. */

/** Cheapest/fastest model by default (moderation + short comedy prompts
 * don't need frontier reasoning). Override with LLM_MODEL for a smarter
 * writers' room, e.g. LLM_MODEL=claude-opus-5. */
const MODEL = process.env.LLM_MODEL ?? "claude-haiku-4-5";

export interface ModerationResult {
  allowed: boolean;
  reason: string;
  title: string;
  videoPrompt: string;
  /** One prompt per scene; single-scene clips have exactly one entry.
   * Multi-scene episodes share a character sheet for visual continuity. */
  scenePrompts: string[];
}

const VIBE = `The stream is "INFINITE" — an endless AI cartoon channel that pokes fun at
what's going on in bitcoin, freedom tech, and AI. The comedy target is ideas, hype cycles,
and absurd situations — never cruelty toward individuals. Tone: playful, absurdist, deadpan,
early-2000s late-night-cartoon energy. Light roasting is fine; mean-spirited, hateful,
harassing, sexual, gory, or targeted content is not.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

async function callClaude(system: string, user: string): Promise<string> {
  const client = getClient();
  const base = {
    model: MODEL,
    // On thinking-by-default models (Opus 5), reasoning counts against
    // max_tokens: a low cap gets fully consumed before any text appears
    // ("no JSON in model response"). Keep generous headroom either way.
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }] as Anthropic.MessageParam[],
  };
  // effort + server-side fallbacks only exist on the Opus 5 tier; Haiku
  // rejects them (and doesn't think unprompted, so it's fast as-is).
  const response = MODEL.includes("opus-5")
    ? await client.beta.messages.create({
        ...base,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
      })
    : await client.messages.create(base);
  if (response.stop_reason === "refusal") {
    throw new Error("model_refused");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("model response truncated at max_tokens");
  }
  const text = response.content.find((b) => b.type === "text");
  return text && "text" in text ? text.text : "";
}

/** Pull the first JSON object out of a model response, tolerating fences. */
function parseJson<T>(raw: string): T {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // Log a snippet so prod logs show WHAT came back, not just that it failed.
    console.error(
      `no JSON in model response (len=${raw.length}): ${raw.slice(0, 200)}`,
    );
    throw new Error("no JSON in model response");
  }
  return JSON.parse(match[0]) as T;
}

/** Moderate a submitted idea and write the episode in one call.
 * `segments` holds the scene lengths in seconds — one entry for a normal
 * clip, several for a long episode rendered as chained scenes. */
export async function moderateAndExpand(
  idea: string,
  segments: number[] = [config.clipDuration],
): Promise<ModerationResult> {
  if (mockMode.llm) return mockModerate(idea, segments);

  const multi = segments.length > 1;
  const sceneSpec = multi
    ? `"characterSheet": string, // 1-2 sentences naming and visually describing the recurring characters/setting, reused verbatim in every scene render
  "scenes": [string]        // exactly ${segments.length} scene prompts, one per array entry. Scene i is animated for these lengths in order: ${segments.join("s, ")}s. Together they form ONE escalating sketch; each scene starts EXACTLY where the previous ended (the renders are chained frame-to-frame), so write the beats as continuous action with an escalating gag and a punchline in the final scene. Each entry: 2-4 sentences of concrete visual action plus any short spoken line.`
    : `"videoPrompt": string     // 2-4 sentences describing ONE self-contained comedic scene for a ${segments[0]}-second animated clip: characters, setting, action, a visual punchline. Pace it for ${segments[0]} seconds. Include any short spoken line or sound gag. Do not describe the art style; that is appended separately.`;

  const system = `${VIBE}

You are the channel's standards-and-practices editor AND head writer. Given a viewer-submitted
idea, decide whether it fits the channel, and if it does, write the video generation prompt${multi ? "s" : ""}.

Respond with ONLY a JSON object:
{
  "allowed": boolean,       // false for mean-spirited, hateful, harassing, sexual, gory, illegal, or targeted-at-a-private-person content
  "reason": string,         // one playful sentence shown to the submitter (esp. when rejected)
  "title": string,          // punchy on-screen title, max 8 words
  ${sceneSpec}
}`;

  const result = await callClaude(system, `Viewer idea: ${JSON.stringify(idea)}`);
  const parsed = parseJson<
    ModerationResult & { characterSheet?: string; scenes?: string[] }
  >(result);

  const base = {
    allowed: Boolean(parsed.allowed),
    reason: String(parsed.reason ?? ""),
    title: String(parsed.title ?? "Untitled").slice(0, 80),
  };
  if (multi) {
    const sheet = String(parsed.characterSheet ?? "").trim();
    const scenes = (Array.isArray(parsed.scenes) ? parsed.scenes : [])
      .slice(0, segments.length)
      .map((s) => `${String(s)} ${sheet} ${STYLE_PROMPT}`.trim());
    if (base.allowed && scenes.length !== segments.length) {
      throw new Error("episode writer returned wrong scene count");
    }
    return { ...base, videoPrompt: scenes[0] ?? "", scenePrompts: scenes };
  }
  const videoPrompt = `${String(parsed.videoPrompt ?? "")} ${STYLE_PROMPT}`.trim();
  return { ...base, videoPrompt, scenePrompts: [videoPrompt] };
}

/** Generate a fresh house idea (also used for the "give me an idea" button). */
export async function generateIdea(): Promise<{ idea: string; title: string }> {
  if (mockMode.llm) return mockIdea();

  const system = `${VIBE}

You are the channel's head writer. Invent ONE fresh comedic premise for a short animated clip.
Rotate between bitcoin culture, freedom tech, and AI as targets. Be specific and visual —
a scene, not a topic. Respond with ONLY a JSON object:
{ "title": string, "idea": string }  // idea: 1-2 sentences, the pitch a viewer might have typed`;

  const result = await callClaude(
    system,
    `Pitch me one clip. Make it different from the obvious first idea you'd reach for. Random seed: ${Math.random().toString(36).slice(2)}`,
  );
  const parsed = parseJson<{ title: string; idea: string }>(result);
  return { idea: String(parsed.idea ?? ""), title: String(parsed.title ?? "") };
}

// ---------- mock fallbacks (no API key) ----------

const BLOCKLIST = ["kill", "murder", "nazi", "rape", "porn", "sex", "gore"];

function mockModerate(idea: string, segments: number[]): ModerationResult {
  const lower = idea.toLowerCase();
  const blocked = BLOCKLIST.some((w) => lower.includes(w));
  const videoPrompt = `${idea}. ${STYLE_PROMPT}`;
  return {
    allowed: !blocked,
    reason: blocked
      ? "Standards & Practices says: keep it playful, champ."
      : "Greenlit by a mock producer (no LLM key set).",
    title: idea.split(/\s+/).slice(0, 6).join(" "),
    videoPrompt,
    scenePrompts: segments.map((_, i) =>
      segments.length > 1 ? `${videoPrompt} (scene ${i + 1})` : videoPrompt,
    ),
  };
}

const MOCK_IDEAS: { title: string; idea: string }[] = [
  {
    title: "Node Runner's Lament",
    idea: "A heroic action figure spends his entire training montage waiting for the initial block download progress bar.",
  },
  {
    title: "The Seed Phrase Heist",
    idea: "Spy-thriller villains crack a vault only to find 24 words engraved on a titanium plate they cannot pronounce.",
  },
  {
    title: "AGI Intern",
    idea: "A superintelligent AI is hired at a startup and immediately gets stuck in a stand-up meeting that never ends.",
  },
  {
    title: "Cold Storage",
    idea: "An arctic explorer keeps his private keys in an actual glacier and must battle a walrus to make a payment.",
  },
];

function mockIdea() {
  return MOCK_IDEAS[Math.floor(Math.random() * MOCK_IDEAS.length)];
}
