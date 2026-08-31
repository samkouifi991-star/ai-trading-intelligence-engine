"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/components/Card";

interface ConnectorHealth {
  sourceKey: string;
  status: "live" | "partial" | "sample" | "blocked";
  detail: string;
  lastAttemptUtc: string;
  lastSuccessUtc: string | null;
}

interface StatusApi {
  nyNow: string;
  daySessionPhase: string;
  gmail: { configured: boolean; connected: boolean };
  health: ConnectorHealth[];
  learning: { totalEvents: number; tradedEvents: number; byInstrument: { instrument: string; count: number; avgConfidence: number }[] };
}

const LABELS: Record<string, string> = {
  calendar: "Economic Calendar (Forex Factory data, live)",
  news: "Breaking News (ForexLive)",
  gmail: "Gmail — Forex Factory Alerts",
  llm: "AI News Understanding (LLM)",
  "marketData:XAUUSD": "Gold (XAUUSD)",
  "marketData:ES": "S&P 500 (ES)",
  "marketData:NQ": "NASDAQ 100 (NQ)",
  "marketData:WTI": "WTI Crude Oil",
  "marketData:EURUSD": "EUR/USD",
  "marketData:GBPUSD": "GBP/USD",
  "marketData:USDJPY": "USD/JPY",
  "marketData:USDCAD": "USD/CAD",
  "marketData:AUDUSD": "AUD/USD",
  "marketData:DXY": "US Dollar Index (DXY)",
  "marketData:VIX": "VIX",
  "marketData:US2Y": "US 2Y Treasury Yield",
  "marketData:US10Y": "US 10Y Treasury Yield",
  "marketData:macro": "Macro bundle (premium vendor)",
};

const STATUS_STYLE: Record<string, string> = {
  live: "bg-long/20 text-long border-long/40",
  partial: "bg-watch/20 text-watch border-watch/40",
  sample: "bg-gray-600/20 text-gray-300 border-gray-600/40",
  blocked: "bg-short/20 text-short border-short/40",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLE[status] ?? STATUS_STYLE.sample}`}>
      {status}
    </span>
  );
}

function Row({ sourceKey, health }: { sourceKey: string; health: ConnectorHealth | undefined }) {
  const label = LABELS[sourceKey] ?? sourceKey;
  if (!health) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel2 px-3 py-2">
        <span className="text-sm text-gray-300">{label}</span>
        <StatusBadge status="sample" />
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-panel2 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-300">{label}</span>
        <StatusBadge status={health.status} />
      </div>
      <p className="mt-1 text-xs text-gray-500" title={health.detail}>
        {health.detail}
      </p>
      <div className="mt-1 flex gap-3 text-[10px] text-gray-600">
        <span>last attempt {new Date(health.lastAttemptUtc).toLocaleTimeString()}</span>
        {health.lastSuccessUtc && <span>last success {new Date(health.lastSuccessUtc).toLocaleTimeString()}</span>}
      </div>
    </div>
  );
}

const MARKET_SYMBOLS = ["XAUUSD", "ES", "NQ", "WTI", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "AUDUSD", "DXY", "VIX", "US2Y", "US10Y"];

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
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          Every source below reflects the outcome of its most recent real fetch attempt — LIVE (succeeded), PARTIAL
          (succeeded but degraded), SAMPLE (deliberately not configured / no attempt made), or BLOCKED (a live
          attempt was made and failed — network, auth, or schema issue). Nothing here is a static config flag.
        </p>
        <button
          onClick={runTick}
          disabled={loading}
          className="whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {loading ? "Running…" : "Run tick now"}
        </button>
      </div>

      <Card title="News & Calendar Intelligence Layer">
        <div className="space-y-2">
          <Row sourceKey="calendar" health={healthByKey.get("calendar")} />
          <Row sourceKey="news" health={healthByKey.get("news")} />
          <Row sourceKey="gmail" health={healthByKey.get("gmail")} />
          <Row sourceKey="llm" health={healthByKey.get("llm")} />
        </div>
        {status && !status.gmail.configured && (
          <p className="mt-2 text-xs text-gray-500">
            Gmail: not configured (set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI). Once configured, visit{" "}
            <code className="text-gray-400">/api/gmail/connect</code> to connect the account that receives Forex
            Factory alerts.
          </p>
        )}
        {status?.gmail.configured && !status.gmail.connected && (
          <p className="mt-2 text-xs text-gray-500">
            Gmail: configured but not connected yet — visit <code className="text-gray-400">/api/gmail/connect</code>.
          </p>
        )}
      </Card>

      <Card title="Market Data (per instrument)">
        <div className="grid gap-2 sm:grid-cols-2">
          {MARKET_SYMBOLS.map((sym) => (
            <Row key={sym} sourceKey={`marketData:${sym}`} health={healthByKey.get(`marketData:${sym}`)} />
          ))}
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
