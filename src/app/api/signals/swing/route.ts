import { NextResponse } from "next/server";
import { runSwingEngine } from "@/lib/pipeline/swingEngine";
import { getRecentSignals } from "@/lib/db/repository";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";
  try {
    if (fresh) {
      const result = await runSwingEngine(new Date());
      return NextResponse.json(result);
    }
    const recent = getRecentSignals("SWING", 50);
    return NextResponse.json({ candidates: recent, ranked: recent, cached: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
