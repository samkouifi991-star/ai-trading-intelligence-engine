import { NextResponse } from "next/server";
import { getCalendarConnector } from "@/lib/ingestion/forexFactoryCalendar";
import { getNewsConnector } from "@/lib/ingestion/forexFactoryNews";
import { getMarketDataConnector } from "@/lib/ingestion/marketData";
import { isLlmConfigured } from "@/lib/llm/client";
import { getLearningStats } from "@/lib/db/repository";
import { getDaySessionPhase, nyNowLabel } from "@/lib/time/session";

export async function GET() {
  const { mode: calendarMode } = getCalendarConnector();
  const { mode: newsMode } = getNewsConnector();
  const { mode: marketDataMode } = getMarketDataConnector();

  return NextResponse.json({
    nyNow: nyNowLabel(),
    daySessionPhase: getDaySessionPhase(),
    connectors: {
      calendar: calendarMode,
      news: newsMode,
      marketData: marketDataMode,
      llm: isLlmConfigured() ? "live" : "heuristic-fallback",
    },
    learning: getLearningStats(),
  });
}
