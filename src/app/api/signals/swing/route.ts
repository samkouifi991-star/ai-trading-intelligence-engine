import { NextResponse } from "next/server";
import { runSwingEngine } from "@/lib/pipeline/swingEngine";
import { getRecentSignals, getEngineTickSummary, saveEngineTickSummary } from "@/lib/db/repository";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";
  try {
    if (fresh) {
      const result = await runSwingEngine(new Date());
      return NextResponse.json(result);
    }
    const recent = getRecentSignals("SWING", 50);
    const tick = getEngineTickSummary("SWING");
    if (!tick) {
      return NextResponse.json({ candidates: recent, ranked: recent, cached: true, tickStatus: "LOADING" });
    }
    return NextResponse.json({
      ...tick.summary,
      candidates: recent,
      ranked: recent,
      cached: true,
      tickStatus: tick.status,
      tickAtUtc: tick.tickAtUtc,
    });
  } catch (err) {
    saveEngineTickSummary("SWING", "ERROR", { error: String(err) });
    return NextResponse.json({ error: String(err), tickStatus: "ERROR" }, { status: 500 });
  }
}
