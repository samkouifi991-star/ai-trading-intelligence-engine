"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/components/Card";

interface ConnectorHealth {
  sourceKey: string;
  status: "live" | "partial" | "sample" | "blocked";
  detail: string;
  lastAttemptUtc: string;
  lastSuccessUtc: string | null;
  latencyMs: number | null;
  realtime: boolean | null;
  streamingMode: "streaming" | "polling" | null;
  marketOpen: boolean | null;
}

interface StatusApi {
  nyNow: string;
  daySessionPhase: string;
  gmail: { configured: boolean; connected: boolean };
  health: ConnectorHealth[];
  learning: { totalEvents: number; tradedEvents: number; byInstrument: { instrument: string; count: number; avgConfidence: number }[] };
}

type Role = "PRIMARY" | "SECONDARY" | "PRIMARY TRIGGER" | "PRIMARY PRICE" | "CONFIRMATION" | "MACRO ONLY" | "ANALYSIS";

const ROWS: { sourceKey: string; label: string; role: Role }[] = [
  { sourceKey: "calendar", label: "Forex Factory Calendar", role: "PRIMARY" },
  { sourceKey: "news:forexfactory", label: "Forex Factory News", role: "PRIMARY" },
  { sourceKey: "news:forexlive", label: "ForexLive (secondary)", role: "SECONDARY" },
  { sourceKey: "gmail", label: "Gmail — Forex Factory Alerts", role: "PRIMARY TRIGGER" },
  { sourceKey: "llm", label: "AI News Understanding (LLM)", role: "ANALYSIS" },
  { sourceKey: "marketData:XAUUSD", label: "Gold (XAUUSD)", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:ES", label: "S&P 500 (ES)", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:NQ", label: "NASDAQ 100 (NQ)", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:WTI", label: "WTI Crude Oil", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:EURUSD", label: "EUR/USD", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:GBPUSD", label: "GBP/USD", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:USDJPY", label: "USD/JPY", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:USDCAD", label: "USD/CAD", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:AUDUSD", label: "AUD/USD", role: "PRIMARY PRICE" },
  { sourceKey: "marketData:DXY", label: "US Dollar Index (DXY)", role: "CONFIRMATION" },
  { sourceKey: "marketData:VIX", label: "VIX", role: "CONFIRMATION" },
  { sourceKey: "marketData:US2Y_PROXY", label: "2Y Rate Pressure (ZT futures)", role: "CONFIRMATION" },
  { sourceKey: "marketData:US10Y_PROXY", label: "10Y Rate Pressure (ZN futures)", role: "CONFIRMATION" },
  { sourceKey: "marketData:FRED_DGS2", label: "FRED US 2Y Yield (daily)", role: "MACRO ONLY" },
  { sourceKey: "marketData:FRED_DGS10", label: "FRED US 10Y Yield (daily)", role: "MACRO ONLY" },
];

const STATUS_STYLE: Record<string, string> = {
  live: "bg-long/20 text-long border-long/40",
  partial: "bg-watch/20 text-watch border-watch/40",
  sample: "bg-gray-600/20 text-gray-300 border-gray-600/40",
  blocked: "bg-short/20 text-short border-short/40",
};

const ROLE_STYLE: Record<Role, string> = {
  PRIMARY: "text-gray-200",
  "PRIMARY TRIGGER": "text-gray-200",
  "PRIMARY PRICE": "text-gray-200",
  SECONDARY: "text-gray-500",
  CONFIRMATION: "text-accent",
  "MACRO ONLY": "text-gray-500",
  ANALYSIS: "text-gray-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[status] ?? STATUS_STYLE.sample}`}>
      {status}
    </span>
  );
}

function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s old`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m old`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h old`;
  return `${Math.round(ms / 86_400_000)}d old`;
}

function formatLatency(health: ConnectorHealth | undefined): string {
  if (!health) return "—";
  if (health.sourceKey === "gmail") return "event-driven";
  if (health.streamingMode === "streaming") return "streaming";
  if (health.latencyMs === null) return "—";
  return `${health.latencyMs}ms`;
}

function Row({ row, health }: { row: (typeof ROWS)[number]; health: ConnectorHealth | undefined }) {
  const status = health?.status ?? "unknown";
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-1.5 pr-3 text-sm text-gray-200" title={health?.detail ?? "no attempt recorded yet"}>
        {row.label}
      </td>
      <td className="py-1.5 pr-3">
        <StatusBadge status={status} />
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap font-mono text-xs text-gray-400">{formatLatency(health)}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap font-mono text-xs text-gray-400">{formatAge(health?.lastSuccessUtc ?? null)}</td>
      <td className={`py-1.5 whitespace-nowrap text-[10px] font-semibold uppercase ${ROLE_STYLE[row.role]}`}>{row.role}</td>
    </tr>
  );
}

export default function LiveDataStatusPage() {
  const [status, setStatus] = useState<StatusApi | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const s = await fetch("/api/status").then((r) => r.json());
    setStatus(s);
  }, []);

  const runTick = useCallback(async () => {
    setLoading(true);
    try {
      await fetch("/api/analyze", { method: "POST" });
      await load();
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const healthByKey = new Map((status?.health ?? []).map((h) => [h.sourceKey, h]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-gray-400">
          Every row reflects the outcome of its most recent real fetch attempt — never a static config flag. LIVE
          (succeeded), PARTIAL (succeeded but degraded), SAMPLE (deliberately not configured / no attempt made), or
          BLOCKED (a live attempt was made and failed). ROLE distinguishes what a source is actually used for —
          PRIMARY/SECONDARY news and calendar sources, PRIMARY PRICE (tradable instruments), CONFIRMATION (the Day
          engine&rsquo;s real-time cross-market checks), and MACRO ONLY (daily context never used for intraday
          confirmation) — so &ldquo;connected&rdquo; is never confused with &ldquo;suitable for day trading.&rdquo;
        </p>
        <button
          onClick={runTick}
          disabled={loading}
          className="whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {loading ? "Running…" : "Run tick now"}
        </button>
      </div>

      {status && !status.gmail.configured && (
        <div className="rounded-md border border-watch/40 bg-watch/10 px-3 py-2 text-xs text-watch">
          Gmail not configured (set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI). Once configured, visit{" "}
          <code className="text-gray-300">/api/gmail/connect</code> to connect the account that receives Forex
          Factory alerts.
        </div>
      )}
      {status?.gmail.configured && !status.gmail.connected && (
        <div className="rounded-md border border-watch/40 bg-watch/10 px-3 py-2 text-xs text-watch">
          Gmail configured but not connected yet — visit <code className="text-gray-300">/api/gmail/connect</code>.
        </div>
      )}

      <Card title="Data Sources">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase text-gray-500">
                <th className="pb-1.5 pr-3 font-medium">Source</th>
                <th className="pb-1.5 pr-3 font-medium">Status</th>
                <th className="pb-1.5 pr-3 font-medium">Latency</th>
                <th className="pb-1.5 pr-3 font-medium">Age</th>
                <th className="pb-1.5 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <Row key={row.sourceKey} row={row} health={healthByKey.get(row.sourceKey)} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Learning Database">
        {status && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border bg-panel2 px-3 py-2">
              <div className="text-2xl font-bold tabular-nums">{status.learning.totalEvents}</div>
              <div className="text-[10px] uppercase text-gray-500">events recorded</div>
            </div>
            <div className="rounded-md border border-border bg-panel2 px-3 py-2">
              <div className="text-2xl font-bold tabular-nums">{status.learning.tradedEvents}</div>
              <div className="text-[10px] uppercase text-gray-500">became a trade</div>
            </div>
            <div className="rounded-md border border-border bg-panel2 px-3 py-2 sm:col-span-1">
              <div className="text-[10px] uppercase text-gray-500">by instrument</div>
              <div className="mt-1 space-y-0.5 text-xs text-gray-300">
                {status.learning.byInstrument.slice(0, 4).map((i) => (
                  <div key={i.instrument} className="flex justify-between">
                    <span>{i.instrument}</span>
                    <span className="text-gray-500">{i.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
