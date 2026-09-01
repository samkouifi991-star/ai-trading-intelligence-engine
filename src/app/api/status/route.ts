import { NextResponse } from "next/server";
import { getAllConnectorHealth } from "@/lib/ingestion/connectorHealth";
import { isLlmConfigured } from "@/lib/llm/client";
import { isGmailConfigured, isGmailConnected } from "@/lib/gmail/client";
import { getLearningStats } from "@/lib/db/repository";
import { getDaySessionPhase, nyNowLabel } from "@/lib/time/session";
import { getAppMode } from "@/lib/config/appMode";

function statusFor(health: ReturnType<typeof getAllConnectorHealth>, key: string): string {
  // "unknown" (not "sample") when no attempt has been recorded yet — e.g. a
  // production-mode tick that failed before reaching this source. Only an
  // actual recorded sample-fallback attempt should read as "sample".
  return health.find((h) => h.sourceKey === key)?.status ?? "unknown";
}

export async function GET() {
  const health = getAllConnectorHealth();

  return NextResponse.json({
    appMode: getAppMode(),
    nyNow: nyNowLabel(),
    daySessionPhase: getDaySessionPhase(),
    connectors: {
      // Coarse labels kept for the two dashboard header pills (backward compatible).
      calendar: statusFor(health, "calendar"),
      news: statusFor(health, "news:forexfactory"),
      marketData: statusFor(health, "marketData:XAUUSD"),
      llm: isLlmConfigured() ? statusFor(health, "llm") : "heuristic-fallback",
    },
    gmail: {
      configured: isGmailConfigured(),
      connected: isGmailConnected(),
    },
    health,
    learning: getLearningStats(),
  });
}
