import { NextResponse } from "next/server";
import { getRecentStories } from "@/lib/db/repository";
import { currentDecayFactor } from "@/lib/news/decay";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const horizon = (url.searchParams.get("horizon") as "day" | "swing") ?? "day";
  const stories = getRecentStories(40).map((s) => ({
    ...s,
    currentDecayFactor: currentDecayFactor(s, horizon),
  }));
  return NextResponse.json({ stories });
}
