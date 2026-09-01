import { NextResponse } from "next/server";
import { runDayEngine } from "@/lib/pipeline/dayEngine";
import { getRecentSignals, getEngineTickSummary, saveEngineTickSummary } from "@/lib/db/repository";
import { getDaySessionPhase, minutesRemainingInActiveWindow, minutesUntilActiveWindow, nyNowLabel } from "@/lib/time/session";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";

  const now = new Date();
  const session = {
    phase: getDaySessionPhase(now),
    nyNow: nyNowLabel(now),
    minutesUntilActiveWindow: minutesUntilActiveWindow(now),
    minutesRemainingInActiveWindow: minutesRemainingInActiveWindow(now),
  };

  try {
    if (fresh) {
      const result = await runDayEngine(now);
      return NextResponse.json({ session, ...result });
    }
    const recent = getRecentSignals("DAY", 50);
    const tick = getEngineTickSummary("DAY");
    if (!tick) {
      // No engine tick has ever completed in this deployment/DB — genuinely
      // still loading, not a stuck/broken state. The client should keep
      // polling and show "LOADING", never a bare blank string forever.
      return NextResponse.json({ session, candidates: recent, ranked: recent, cached: true, tickStatus: "LOADING" });
    }
    return NextResponse.json({
      // Persisted tick summary first (regimeSummary/suppressed/noTradeReasons
      // etc. from the last completed run) — then the always-fresh fields
      // override it, so a stale candidates/ranked snapshot from the summary
      // blob never shadows the DB's actual most-recent signals.
      ...tick.summary,
      session,
      candidates: recent,
      ranked: recent,
      cached: true,
      tickStatus: tick.status,
      tickAtUtc: tick.tickAtUtc,
    });
  } catch (err) {
    saveEngineTickSummary("DAY", "ERROR", { error: String(err) });
    return NextResponse.json({ error: String(err), tickStatus: "ERROR" }, { status: 500 });
  }
}
