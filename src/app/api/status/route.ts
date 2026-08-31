import { NextResponse } from "next/server";
import { getAllConnectorHealth } from "@/lib/ingestion/connectorHealth";
import { isLlmConfigured } from "@/lib/llm/client";
import { isGmailConfigured, isGmailConnected } from "@/lib/gmail/client";
import { getLearningStats } from "@/lib/db/repository";
import { getDaySessionPhase, nyNowLabel } from "@/lib/time/session";

function statusFor(health: ReturnType<typeof getAllConnectorHealth>, key: string): string {
  return health.find((h) => h.sourceKey === key)?.status ?? "sample";
}

export async function GET() {
  const health = getAllConnectorHealth();

  return NextResponse.json({
    nyNow: nyNowLabel(),
    daySessionPhase: getDaySessionPhase(),
    connectors: {
      // Coarse labels kept for the two dashboard header pills (backward compatible).
      calendar: statusFor(health, "calendar"),
      news: statusFor(health, "news"),
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
