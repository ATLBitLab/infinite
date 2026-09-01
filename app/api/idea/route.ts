import { generateIdea } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const idea = await generateIdea();
    return Response.json(idea);
  } catch (err) {
    console.error("idea generation failed:", err);
    return Response.json({ error: "The writers' room is on strike. Try again." }, { status: 500 });
  }
}
