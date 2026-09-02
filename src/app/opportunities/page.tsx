"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/components/Card";
import DevModeBanner from "@/components/DevModeBanner";
import { SampleDataBadge } from "@/components/StatusPill";

interface CurrencyStrengthComponent {
  score: number;
  status: "available" | "not_available_yet";
  detail?: string;
}

interface CurrencyStrengthEntry {
  currency: string;
  strengthScore: number;
  computedAtUtc: string;
  components: {
    economic: CurrencyStrengthComponent & { sampleSize: number };
    news: CurrencyStrengthComponent;
    centralBank: CurrencyStrengthComponent;
    yield: CurrencyStrengthComponent;
    risk: CurrencyStrengthComponent;
    priceAction: CurrencyStrengthComponent & { pairsUsed: string[] };
  };
}

interface EconomicEventEntry {
  id: string;
  event: string;
  currency: string;
  eventTimeUtc: string;
  impact: "high" | "medium" | "low";
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  source: string;
  currencyScore: number | null;
  directionality: string | null;
  isSampleSource: boolean | null;
}

interface SourceHealth {
  sourceKey: string;
  status: "live" | "partial" | "sample" | "blocked";
  detail: string;
  lastAttemptUtc: string;
  lastSuccessUtc: string | null;
}

interface StatusApi {
  appMode: string;
  databaseConfigured: boolean;
  health: SourceHealth[];
  error?: string;
}

const STRENGTH_LABELS: Record<string, string> = {
  economic: "Economic",
  news: "News",
  centralBank: "Central Bank",
  yield: "Yield",
  risk: "Risk Sentiment",
  priceAction: "Price Action",
};

function StrengthBar({ entry }: { entry: CurrencyStrengthEntry }) {
  const [expanded, setExpanded] = useState(false);
  const pct = (entry.strengthScore + 100) / 2; // -100..100 -> 0..100
  const positive = entry.strengthScore >= 0;

  return (
    <div className="rounded-md border border-border bg-panel2 px-3 py-2">
      <button className="flex w-full items-center gap-3" onClick={() => setExpanded((e) => !e)}>
        <span className="w-10 font-mono text-sm font-semibold">{entry.currency}</span>
        <div className="relative h-4 flex-1 overflow-hidden rounded bg-panel">
          <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
          <div
            className={`absolute inset-y-0 ${positive ? "bg-long/70" : "bg-short/70"}`}
            style={positive ? { left: "50%", width: `${pct - 50}%` } : { right: "50%", width: `${50 - pct}%` }}
          />
        </div>
        <span className={`w-12 text-right font-mono text-sm font-bold ${positive ? "text-long" : "text-short"}`}>
          {entry.strengthScore > 0 ? "+" : ""}
          {entry.strengthScore}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-border/60 pt-2 sm:grid-cols-3">
          {(Object.keys(STRENGTH_LABELS) as (keyof CurrencyStrengthEntry["components"])[]).map((key) => {
            const c = entry.components[key];
            return (
              <div key={key} className="rounded border border-border/60 bg-panel px-2 py-1 text-[11px]">
                <div className="flex items-center justify-between text-gray-400">
                  <span>{STRENGTH_LABELS[key]}</span>
                  <span className={c.status === "available" ? "font-mono font-semibold text-gray-200" : "text-gray-600"}>
                    {c.status === "available" ? (c.score > 0 ? `+${c.score}` : c.score) : "N/A"}
                  </span>
                </div>
                {c.status !== "available" && <div className="mt-0.5 text-gray-600">not available yet</div>}
                {c.detail && c.status === "available" && <div className="mt-0.5 truncate text-gray-500" title={c.detail}>{c.detail}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EventRow({ e }: { e: EconomicEventEntry }) {
  const released = e.actual !== null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-xs last:border-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-10 shrink-0 font-mono text-gray-500">{e.currency}</span>
        <span
          className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${
            e.impact === "high" ? "bg-short/20 text-short" : e.impact === "medium" ? "bg-watch/20 text-watch" : "bg-gray-600/20 text-gray-400"
          }`}
        >
          {e.impact}
        </span>
        <span className="truncate text-gray-200">{e.event}</span>
        {e.isSampleSource && <SampleDataBadge />}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {released ? (
          <>
            <span className="text-gray-500">
              A {e.actual} / F {e.forecast ?? "—"} / P {e.previous ?? "—"}
            </span>
            {e.currencyScore !== null && (
              <span className={`font-mono font-bold ${e.currencyScore > 0 ? "text-long" : e.currencyScore < 0 ? "text-short" : "text-gray-500"}`}>
                {e.currencyScore > 0 ? "+" : ""}
                {e.currencyScore}
              </span>
            )}
          </>
        ) : (
          <span className="text-gray-500">{new Date(e.eventTimeUtc).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        )}
      </div>
    </div>
  );
}

export default function OpportunitiesPage() {
  const [strength, setStrength] = useState<CurrencyStrengthEntry[]>([]);
  const [events, setEvents] = useState<EconomicEventEntry[]>([]);
  const [status, setStatus] = useState<StatusApi | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const [strengthRes, eventsRes, statusRes] = await Promise.all([
      fetch("/api/ti/currency-strength").then((r) => r.json()),
      fetch("/api/ti/economic/releases").then((r) => r.json()),
      fetch("/api/ti/status").then((r) => r.json()),
    ]);
    setStrength(strengthRes.currencies ?? []);
    setEvents(eventsRes.events ?? []);
    setStatus(statusRes);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetch("/api/ti/analyze", { method: "POST" });
      await load();
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const sortedStrength = [...strength].sort((a, b) => b.strengthScore - a.strengthScore);
  // Dedupe by (event, currency, actual, forecast) — the sample-mode calendar
  // fixture (development mode, live feed unreachable) can regenerate the
  // same conceptual release with a fresh id/timestamp on consecutive ticks;
  // a real Forex Factory feed does not do this, so this is a display-layer
  // cleanup for sample noise, not a masking of real duplicate data.
  const dedupe = (list: EconomicEventEntry[]) => {
    const seen = new Set<string>();
    return list.filter((e) => {
      const key = `${e.event}|${e.currency}|${e.actual}|${e.forecast}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const released = dedupe(events.filter((e) => e.actual !== null).slice().reverse());
  const upcoming = dedupe(events.filter((e) => e.actual === null));

  return (
    <div className="space-y-4">
      <DevModeBanner appMode={status?.appMode} />

      {status && !status.databaseConfigured && (
        <div className="rounded-md border-2 border-short bg-short/10 px-4 py-3 text-sm text-short">
          <strong>Database not configured.</strong> Set <code>DATABASE_URL</code> to your Supabase project&rsquo;s
          Postgres connection string, then run{" "}
          <code>supabase/migrations/0001_trading_intelligence_schema.sql</code> against it once. See the
          README&rsquo;s credentials checklist.
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Trading Intelligence — Phase 1</h1>
          <p className="text-xs text-gray-500">
            Currency strength + economic surprise scoring. Technical/news/trader/cross-market layers and final trade
            ranking land in later phases — see the README&rsquo;s build-phase notes.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Currency Strength">
          {sortedStrength.length === 0 ? (
            <p className="text-sm text-gray-500">No currency strength computed yet — click &ldquo;Refresh now&rdquo;.</p>
          ) : (
            <div className="space-y-1.5">
              {sortedStrength.map((entry) => (
                <StrengthBar key={entry.currency} entry={entry} />
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] text-gray-600">
            Click a currency to see its component breakdown. A component reading &ldquo;N/A&rdquo; means that real data
            source isn&rsquo;t wired/live yet — it is excluded from the score, never estimated.
          </p>
        </Card>

        <Card title="Data Sources">
          {!status || status.health.length === 0 ? (
            <p className="text-sm text-gray-500">No ingestion has run yet.</p>
          ) : (
            <div className="space-y-1 text-xs">
              {status.health.map((h) => (
                <div key={h.sourceKey} className="flex items-center justify-between gap-2 border-b border-border/60 py-1 last:border-0">
                  <span className="truncate text-gray-300">{h.sourceKey}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      h.status === "live"
                        ? "bg-long/20 text-long"
                        : h.status === "partial"
                          ? "bg-watch/20 text-watch"
                          : h.status === "sample"
                            ? "bg-gray-600/20 text-gray-300"
                            : "bg-short/20 text-short"
                    }`}
                  >
                    {h.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Economic Releases">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-[10px] font-semibold uppercase text-gray-500">Recent (surprise score)</h3>
            {released.length === 0 ? <p className="text-xs text-gray-500">No releases in the last 48h.</p> : released.map((e) => <EventRow key={e.id} e={e} />)}
          </div>
          <div>
            <h3 className="mb-1 text-[10px] font-semibold uppercase text-gray-500">Upcoming</h3>
            {upcoming.length === 0 ? <p className="text-xs text-gray-500">No high/medium-impact events in the next 72h.</p> : upcoming.map((e) => <EventRow key={e.id} e={e} />)}
          </div>
        </div>
      </Card>
    </div>
  );
}
