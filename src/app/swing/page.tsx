"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/components/Card";
import SignalDetail from "@/components/SignalDetail";
import { ModePill } from "@/components/StatusPill";
import type { TradeSignal } from "@/lib/types";

interface SwingApiResponse {
  regimeSummary?: string;
  centralBankBias?: string;
  activeThemes?: string[];
  candidates: TradeSignal[];
  ranked: TradeSignal[];
  suppressed?: { instrument: string; reason: string }[];
  noIdeaReasons?: string[];
}

interface StatusApi {
  nyNow: string;
  connectors: { calendar: string; news: string; marketData: string; llm: string };
}

export default function SwingDashboard() {
  const [data, setData] = useState<SwingApiResponse | null>(null);
  const [status, setStatus] = useState<StatusApi | null>(null);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadCached = useCallback(async () => {
    const [s, st, up] = await Promise.all([
      fetch("/api/signals/swing").then((r) => r.json()),
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/economic/upcoming").then((r) => r.json()),
    ]);
    setData(s);
    setStatus(st);
    setUpcoming(up.events ?? []);
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
    const interval = setInterval(loadCached, 120_000);
    return () => clearInterval(interval);
  }, [loadCached]);

  const ranked = data?.ranked ?? [];
  const activeIdeas = ranked.filter((s) => s.finalStatus === "TRADE" || s.finalStatus === "WATCH");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          {status && (
            <>
              <span>{status.nyNow} ET</span>
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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Macro Regime" className="lg:col-span-2">
          <p className="text-sm text-gray-300">{data?.regimeSummary ?? "Loading…"}</p>
        </Card>
        <Card title="Central-Bank Bias">
          <p className="text-sm text-gray-300">{data?.centralBankBias ?? "—"}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Major Themes">
          {!data?.activeThemes || data.activeThemes.length === 0 ? (
            <p className="text-sm text-gray-500">No structural swing-horizon themes currently active.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.activeThemes.map((t) => (
                <span key={t} className="rounded-full border border-border bg-panel2 px-3 py-1 text-xs capitalize text-gray-300">
                  {t.replace("_", " ")}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="Positioning">
          <p className="text-sm text-gray-500">
            No live positioning/flows (COT-style) feed is wired up yet — the positioning/flows
            score is held at a neutral 50/100 placeholder rather than fabricated. Wire a real
            source behind <code className="text-gray-400">swingScore.positioningFlowsScore</code> to activate this.
          </p>
        </Card>
      </div>

      <Card title="Active Swing Ideas">
        {activeIdeas.length === 0 ? (
          <p className="text-sm text-gray-500">
            No open swing ideas — no story currently changes the medium-term thesis for any instrument in the universe.
          </p>
        ) : (
          <div className="space-y-3">
            {activeIdeas.map((s) => (
              <SignalDetail key={s.id} signal={s} />
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Upcoming Catalysts">
          {upcoming.length === 0 ? (
            <p className="text-sm text-gray-500">No high-impact events in the next 72h.</p>
          ) : (
            <div className="space-y-1 text-xs">
              {upcoming.slice(0, 8).map((e) => (
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

        <Card title="Technical Trend">
          {ranked.length === 0 ? (
            <p className="text-sm text-gray-500">No instruments scored yet.</p>
          ) : (
            <div className="space-y-1 text-xs">
              {ranked.map((s) => (
                <div key={s.id} className="flex justify-between">
                  <span className="font-mono text-gray-300">{s.instrument}</span>
                  <span className="text-gray-500">technical trend {s.technicalScore ?? "—"}/100</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {data?.noIdeaReasons && data.noIdeaReasons.length > 0 && (
        <Card title="Screened Out">
          <ul className="space-y-1 text-xs text-gray-500">
            {data.noIdeaReasons.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
