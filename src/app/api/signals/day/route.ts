import { NextResponse } from "next/server";
import { runDayEngine } from "@/lib/pipeline/dayEngine";
import { getRecentSignals } from "@/lib/db/repository";
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
    return NextResponse.json({ session, candidates: recent, ranked: recent, cached: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
