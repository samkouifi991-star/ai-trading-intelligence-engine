import type { TradeSignal } from "@/lib/types";
import { DirectionPill, StatusPill } from "./StatusPill";

function fmt(n: number | null, digits = 4): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toFixed(Math.abs(n) > 100 ? 2 : digits);
}

export default function SignalDetail({ signal }: { signal: TradeSignal }) {
  return (
    <div className="rounded-lg border border-border bg-panel2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xl font-bold">{signal.instrument}</span>
          <DirectionPill direction={signal.direction} />
          <StatusPill status={signal.finalStatus} />
          <span className="text-xs text-gray-500">{signal.engine}</span>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums">{signal.confidence}</div>
          <div className="text-[10px] uppercase text-gray-500">confidence</div>
        </div>
      </div>

      <p className="mt-2 text-sm text-gray-300">{signal.catalyst}</p>
      <p className="mt-1 text-xs text-gray-500">{signal.newsSummary}</p>

      {/* Prediction vs. confirmation, shown separately — never blended (spec rule 8) */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <SignedMetric label="News Impact" value={signal.newsImpactScore} />
        <SignedMetric label="Market Confirmation" value={signal.marketConfirmationScore} />
        <div className="rounded border border-accent/40 bg-accent/10 px-2 py-1.5">
          <div className="text-[10px] uppercase text-gray-400">Final Direction</div>
          <div className="font-mono text-sm font-bold">{signal.direction}</div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-gray-500">Data Quality:</span>
        <span className={`font-mono font-bold ${dataQualityColor(signal.dataQualityScore)}`}>{signal.dataQualityScore}/100</span>
        {signal.dataQualityReason && <span className="text-gray-500">— {signal.dataQualityReason}</span>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Metric label="Entry" value={signal.entryZone ? `${fmt(signal.entryZone[0])} – ${fmt(signal.entryZone[1])}` : "—"} />
        <Metric label="Invalidation" value={fmt(signal.invalidation)} />
        <Metric label="Target 1" value={fmt(signal.target1)} />
        <Metric label="Target 2" value={fmt(signal.target2)} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <Metric label="News/Catalyst" value={fmtScore(scoreOf(signal, "news"))} />
        <Metric label="Surprise" value={fmtScore(signal.economicSurpriseScore)} />
        <Metric label="Cross-Mkt" value={fmtScore(signal.crossMarketConfirmationScore)} />
        <Metric label="Technical" value={fmtScore(signal.technicalScore)} />
        <Metric label="Regime" value={fmtScore(signal.marketRegimeScore)} />
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
        <span>Holding: {signal.expectedHoldingPeriod}</span>
        <span>Expires: {new Date(signal.signalExpirationUtc).toLocaleString()}</span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-long">Reasons for</h4>
          <ul className="space-y-1 text-xs text-gray-300">
            {signal.reasonsFor.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-short">Reasons against</h4>
          <ul className="space-y-1 text-xs text-gray-300">
            {signal.reasonsAgainst.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
      </div>

      {signal.upcomingRisks.length > 0 && (
        <div className="mt-3">
          <h4 className="mb-1 text-xs font-semibold uppercase text-watch">Upcoming risks/events</h4>
          <ul className="space-y-1 text-xs text-gray-300">
            {signal.upcomingRisks.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function scoreOf(signal: TradeSignal, kind: "news"): number | null {
  const bd: any = signal.scoreBreakdown;
  if (kind === "news") return bd.newsCatalystScore ?? null;
  return null;
}

function fmtScore(n: number | null): string {
  return n === null ? "—" : String(Math.round(n));
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-panel px-2 py-1.5">
      <div className="text-[10px] uppercase text-gray-500">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

function SignedMetric({ label, value }: { label: string; value: number | null }) {
  const color = value === null ? "text-gray-500" : value > 0 ? "text-long" : value < 0 ? "text-short" : "text-gray-400";
  return (
    <div className="rounded border border-border bg-panel px-2 py-1.5">
      <div className="text-[10px] uppercase text-gray-500">{label}</div>
      <div className={`font-mono text-sm font-bold ${color}`}>
        {value === null ? "—" : `${value > 0 ? "+" : ""}${value}`}
      </div>
    </div>
  );
}

function dataQualityColor(score: number): string {
  if (score >= 90) return "text-long";
  if (score >= 75) return "text-watch";
  if (score >= 60) return "text-watch";
  return "text-short";
}
