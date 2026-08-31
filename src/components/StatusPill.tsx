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

export function ModePill({ mode }: { mode: string }) {
  const live = mode === "live";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        live ? "bg-long/20 text-long" : "bg-watch/20 text-watch"
      }`}
      title={live ? "Connected to a live feed" : "Sample/demo data — no live credentials configured"}
    >
      {live ? "live" : "sample"}
    </span>
  );
}
