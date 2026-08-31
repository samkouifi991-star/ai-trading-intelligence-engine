import { NextResponse } from "next/server";
import { trackReactions } from "@/lib/pipeline/reactionTracking";

export async function GET() {
  const result = await trackReactions(new Date());
  return NextResponse.json(result);
}

export const POST = GET;
