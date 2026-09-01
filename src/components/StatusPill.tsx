export function StatusPill({ status }: { status: "TRADE" | "WATCH" | "NO_TRADE" }) {
  const styles: Record<string, string> = {
    TRADE: "bg-long/20 text-long border-long/40",
    WATCH: "bg-watch/20 text-watch border-watch/40",
    NO_TRADE: "bg-gray-600/20 text-gray-400 border-gray-600/40",
  };
  const labels: Record<string, string> = { TRADE: "TRADE", WATCH: "WATCH", NO_TRADE: "NO TRADE" };
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export function DirectionPill({ direction }: { direction: "LONG" | "SHORT" }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-bold ${
        direction === "LONG" ? "bg-long/20 text-long" : "bg-short/20 text-short"
      }`}
    >
      {direction}
    </span>
  );
}

const MODE_STYLE: Record<string, string> = {
  live: "bg-long/20 text-long",
  partial: "bg-watch/20 text-watch",
  sample: "bg-gray-600/20 text-gray-300",
  blocked: "bg-short/20 text-short",
  unknown: "bg-gray-600/20 text-gray-500",
  "heuristic-fallback": "bg-gray-600/20 text-gray-300",
};

const MODE_TITLE: Record<string, string> = {
  live: "Live data — most recent fetch succeeded",
  partial: "Live data, but degraded (see Live Data Status page)",
  sample: "Sample/demo data — not configured, or no attempt made yet",
  blocked: "A live fetch was attempted and failed — see Live Data Status page",
  unknown: "No fetch attempted yet this session — see Live Data Status page",
  "heuristic-fallback": "OPENAI_API_KEY not set — using keyword heuristic instead of the LLM",
};

export function ModePill({ mode }: { mode: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${MODE_STYLE[mode] ?? MODE_STYLE.sample}`}
      title={MODE_TITLE[mode] ?? mode}
    >
      {mode}
    </span>
  );
}

/** A loud, unmissable badge for anything built from sample/fallback data
 * (development mode only) — never presented indistinguishably from a real
 * calendar event, news story, or signal (spec rule: sample data must always
 * be visually obvious). */
export function SampleDataBadge({ title }: { title?: string }) {
  return (
    <span
      className="rounded border border-watch/50 bg-watch/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-watch"
      title={title ?? "Built from sample/fallback data, not a live source — development mode only"}
    >
      Sample Data
    </span>
  );
}
