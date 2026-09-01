import type { TradeSignal } from "@/lib/types";
import { DirectionPill, StatusPill, SampleDataBadge } from "./StatusPill";

export default function SignalRow({ signal, rank }: { signal: TradeSignal; rank?: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {rank !== undefined && <span className="w-5 text-sm text-gray-500">{rank}</span>}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold">{signal.instrument}</span>
            <DirectionPill direction={signal.direction} />
            <StatusPill status={signal.finalStatus} />
            {signal.usesSampleData && <SampleDataBadge title="One or more required sources for this signal were sample/fallback data, not live." />}
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-400" title={signal.catalyst}>
            {signal.catalyst}
          </p>
        </div>
      </div>
      <div className="text-right">
        <div className="text-lg font-bold tabular-nums">{signal.confidence}</div>
        <div className="text-[10px] uppercase text-gray-500">confidence</div>
      </div>
    </div>
  );
}
