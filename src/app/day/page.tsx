"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/components/Card";
import SignalRow from "@/components/SignalRow";
import SignalDetail from "@/components/SignalDetail";
import { ModePill } from "@/components/StatusPill";
import type { TradeSignal } from "@/lib/types";

interface DayApiResponse {
  session: { phase: string; nyNow: string; minutesUntilActiveWindow: number; minutesRemainingInActiveWindow: number };
  regimeSummary?: string;
  candidates: TradeSignal[];
  ranked: TradeSignal[];
  suppressed?: { instrument: string; reason: string }[];
  noTradeReasons?: string[];
}

interface StoryApi {
  storyId: string;
  lastUpdatedUtc: string;
  currentDecayFactor: number;
  developmentCount: number;
  latestAnalysis: { headline: string; severity: number; riskImpact: string; causalChain: string[] };
}

interface StatusApi {
  nyNow: string;
  daySessionPhase: string;
  connectors: { calendar: string; news: string; marketData: string; llm: string };
}

interface PremarketApi {
  freshness: "fresh" | "stale" | "missing";
  capturedAtUtc: string | null;
  context: {
    regime: { summary: string };
    overnightStories: { headline: string; severity: number; eventType: string; riskImpact: string }[];
    todaysCalendar: { event: string; currency: string; impact: string; eventTimeUtc: string }[];
  } | null;
}

export default function DayDashboard() {
  const [data, setData] = useState<DayApiResponse | null>(null);
  const [stories, setStories] = useState<StoryApi[]>([]);
  const [status, setStatus] = useState<StatusApi | null>(null);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [premarket, setPremarket] = useState<PremarketApi | null>(null);
  const [loading, setLoading] = useState(false);

  const loadCached = useCallback(async () => {
    const [s, st, news, up, pm] = await Promise.all([
      fetch("/api/signals/day").then((r) => r.json()),
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/news/stories?horizon=day").then((r) => r.json()),
      fetch("/api/economic/upcoming").then((r) => r.json()),
      fetch("/api/premarket/latest").then((r) => r.json()),
    ]);
    setData(s);
    setStatus(st);
    setStories(news.stories ?? []);
    setUpcoming(up.events ?? []);
    setPremarket(pm);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetch("/api/analyze", { method: "POST" });
      await loadCached();
    } finally {
      setLoading(false);
    }
  }, [loadCached]);

  useEffect(() => {
    loadCached();
    const interval = setInterval(loadCached, 60_000);
    return () => clearInterval(interval);
  }, [loadCached]);

  const ranked = data?.ranked ?? [];
  const topTrade = ranked.find((s) => s.finalStatus === "TRADE") ?? null;
  const watchlist = ranked.filter((s) => s.finalStatus === "WATCH" && s.id !== topTrade?.id);
  const noTradeReasons = data?.noTradeReasons ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          {status && (
            <>
              <span>{status.nyNow} ET</span>
              <span className="rounded bg-panel2 px-2 py-0.5 text-xs uppercase">{status.daySessionPhase}</span>
              <ModePill mode={status.connectors.calendar} />
              <ModePill mode={status.connectors.news} />
              <ModePill mode={status.connectors.marketData} />
              <span className="text-xs">LLM: {status.connectors.llm}</span>
            </>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      {data?.session.phase !== "active" && (
        <div className="rounded-md border border-watch/40 bg-watch/10 px-4 py-2 text-sm text-watch">
          {data?.session.phase === "prep"
            ? `Prep phase — collecting & analyzing. New day-trade ideas open in ${data.session.minutesUntilActiveWindow} min (10:00 ET).`
            : "Trading window closed (after 13:00 ET) — no new day-trade ideas until tomorrow's 10:00 ET window. Monitoring/decay only."}
        </div>
      )}

      <Card
        title="Pre-Market Context (09:45 ET)"
        right={
          premarket && (
            <span
              className={`text-[10px] uppercase ${
                premarket.freshness === "fresh" ? "text-long" : premarket.freshness === "stale" ? "text-watch" : "text-gray-500"
              }`}
            >
              {premarket.freshness}
              {premarket.capturedAtUtc ? ` · captured ${new Date(premarket.capturedAtUtc).toLocaleTimeString()}` : ""}
            </span>
          )
        }
      >
        {!premarket?.context ? (
          <p className="text-sm text-gray-500">
            No pre-market snapshot captured yet today. POST /api/premarket/capture (schedule it ~09:45 ET) to populate this.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-gray-400">Overnight stories</p>
              {premarket.context.overnightStories.length === 0 ? (
                <p className="text-xs text-gray-500">Nothing material overnight.</p>
              ) : (
                <ul className="space-y-1 text-xs text-gray-300">
                  {premarket.context.overnightStories.slice(0, 6).map((s, i) => (
                    <li key={i}>• {s.headline} <span className="text-gray-500">(severity {s.severity})</span></li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-gray-400">Today&apos;s calendar</p>
              {premarket.context.todaysCalendar.length === 0 ? (
                <p className="text-xs text-gray-500">No high/medium-impact events scheduled.</p>
              ) : (
                <ul className="space-y-1 text-xs text-gray-300">
                  {premarket.context.todaysCalendar.slice(0, 6).map((e, i) => (
                    <li key={i}>
                      • {e.event} ({e.currency}) —{" "}
                      {new Date(e.eventTimeUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Market Regime" className="lg:col-span-2">
          <p className="text-sm text-gray-300">{data?.regimeSummary ?? "Loading…"}</p>
        </Card>
        <Card title="Next Important Event">
          {upcoming.length === 0 ? (
            <p className="text-sm text-gray-500">No high-impact events in the next 72h.</p>
          ) : (
            <div className="space-y-1 text-xs">
              {upcoming.slice(0, 4).map((e) => (
                <div key={e.id} className="flex justify-between gap-2">
                  <span className="truncate text-gray-300">{e.event} ({e.currency})</span>
                  <span className="whitespace-nowrap text-gray-500">
                    {new Date(e.eventTimeUtc ?? e.event_time_utc).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Top Trade">
        {topTrade ? (
          <SignalDetail signal={topTrade} />
        ) : (
          <p className="text-sm text-gray-500">
            No signal currently qualifies as an actionable TRADE (composite ≥ 80, session-window active, cross-asset confirmed). This is expected — the engine does not force trades.
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Watchlist">
          {watchlist.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing on watch right now.</p>
          ) : (
            <div className="space-y-2">
              {watchlist.map((s) => (
                <SignalRow key={s.id} signal={s} />
              ))}
            </div>
          )}
        </Card>

        <Card title="No-Trade Conditions">
          {noTradeReasons.length === 0 ? (
            <p className="text-sm text-gray-500">All instruments have an active catalyst under evaluation.</p>
          ) : (
            <ul className="space-y-1 text-xs text-gray-400">
              {noTradeReasons.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Day Opportunity Ranking">
        {ranked.length === 0 ? (
          <p className="text-sm text-gray-500">No candidates evaluated yet — click Refresh now.</p>
        ) : (
          <div className="space-y-2">
            {ranked.map((s, i) => (
              <SignalRow key={s.id} signal={s} rank={i + 1} />
            ))}
          </div>
        )}
        {data?.suppressed && data.suppressed.length > 0 && (
          <div className="mt-3 border-t border-border pt-2 text-xs text-gray-500">
            <p className="mb-1 font-semibold uppercase">Suppressed (correlated duplicates)</p>
            {data.suppressed.map((s, i) => (
              <p key={i}>• {s.instrument}: {s.reason}</p>
            ))}
          </div>
        )}
      </Card>

      <Card title="Live News">
        {stories.length === 0 ? (
          <p className="text-sm text-gray-500">No stories ingested yet.</p>
        ) : (
          <div className="space-y-2">
            {stories.slice(0, 12).map((s) => (
              <div key={s.storyId} className="rounded-md border border-border bg-panel2 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-200">{s.latestAnalysis.headline}</span>
                  <span className="whitespace-nowrap text-gray-500">
                    decay {Math.round(s.currentDecayFactor * 100)}%
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-gray-500">
                  <span>severity {s.latestAnalysis.severity}</span>
                  <span>·</span>
                  <span>{s.latestAnalysis.riskImpact.replace("_", "-")}</span>
                  <span>·</span>
                  <span>{s.developmentCount} development{s.developmentCount === 1 ? "" : "s"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
