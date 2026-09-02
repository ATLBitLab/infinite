import Anthropic from "@anthropic-ai/sdk";
import { config, mockMode, STYLE_PROMPT } from "./config";

/** LLM layer: idea generation, content moderation, and video-prompt expansion.
 * Falls back to canned behavior when ANTHROPIC_API_KEY is unset. */

const MODEL = "claude-opus-5";

export interface ModerationResult {
  allowed: boolean;
  reason: string;
  title: string;
  videoPrompt: string;
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
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 1024,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("model_refused");
  }
  const text = response.content.find((b) => b.type === "text");
  return text && "text" in text ? text.text : "";
}

/** Pull the first JSON object out of a model response, tolerating fences. */
function parseJson<T>(raw: string): T {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in model response");
  return JSON.parse(match[0]) as T;
}

/** Moderate a submitted idea and expand it into a video prompt in one call. */
export async function moderateAndExpand(
  idea: string,
  durationSec: number = config.clipDuration,
): Promise<ModerationResult> {
  if (mockMode.llm) return mockModerate(idea);

  const system = `${VIBE}

You are the channel's standards-and-practices editor AND head writer. Given a viewer-submitted
idea, decide whether it fits the channel, and if it does, write the video generation prompt.

Respond with ONLY a JSON object:
{
  "allowed": boolean,       // false for mean-spirited, hateful, harassing, sexual, gory, illegal, or targeted-at-a-private-person content
  "reason": string,         // one playful sentence shown to the submitter (esp. when rejected)
  "title": string,          // punchy on-screen title, max 8 words
  "videoPrompt": string     // 2-4 sentences describing ONE self-contained comedic scene for a ${durationSec}-second animated clip: characters, setting, action, a visual punchline. Pace it for ${durationSec} seconds. Include any short spoken line or sound gag. Do not describe the art style; that is appended separately.
}`;

  const result = await callClaude(system, `Viewer idea: ${JSON.stringify(idea)}`);
  const parsed = parseJson<ModerationResult>(result);
  return {
    allowed: Boolean(parsed.allowed),
    reason: String(parsed.reason ?? ""),
    title: String(parsed.title ?? "Untitled").slice(0, 80),
    videoPrompt: `${String(parsed.videoPrompt ?? "")} ${STYLE_PROMPT}`.trim(),
  };
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

function mockModerate(idea: string): ModerationResult {
  const lower = idea.toLowerCase();
  const blocked = BLOCKLIST.some((w) => lower.includes(w));
  return {
    allowed: !blocked,
    reason: blocked
      ? "Standards & Practices says: keep it playful, champ."
      : "Greenlit by a mock producer (no LLM key set).",
    title: idea.split(/\s+/).slice(0, 6).join(" "),
    videoPrompt: `${idea}. ${STYLE_PROMPT}`,
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
