import { NextResponse } from "next/server";
import { getStoryById } from "@/lib/db/repository";
import { buildReactionReport } from "@/lib/pipeline/eventClock";

export async function GET(request: Request, { params }: { params: { storyId: string } }) {
  const story = getStoryById(params.storyId);
  if (!story) return NextResponse.json({ error: "story not found" }, { status: 404 });
  const report = buildReactionReport(story);
  return NextResponse.json(report);
}
