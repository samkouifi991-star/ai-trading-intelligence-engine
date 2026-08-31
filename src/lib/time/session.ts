/**
 * Day-trading session windows, all evaluated in America/New_York local time
 * regardless of the server's own timezone.
 *
 *  - Prep window:   before 10:00 ET  — ingest & analyze, no signals issued.
 *  - Active window: 10:00–13:00 ET   — the ONLY window new day-trade ideas
 *                                       may be generated in.
 *  - Closed:        after 13:00 ET   — monitoring/decay only, no new ideas.
 *
 * The swing engine is not subject to this window; it runs continuously.
 */

const NY_TZ = "America/New_York";

export type DaySessionPhase = "prep" | "active" | "closed";

function nyParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  return {
    weekday: parts.weekday,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

export function isWeekend(date: Date = new Date()): boolean {
  const { weekday } = nyParts(date);
  return weekday === "Sat" || weekday === "Sun";
}

export function getDaySessionPhase(date: Date = new Date()): DaySessionPhase {
  if (isWeekend(date)) return "closed";
  const { hour, minute } = nyParts(date);
  const minutesOfDay = hour * 60 + minute;
  const prepStart = 0; // system begins collecting/analyzing before 10:00 ET
  const activeStart = 10 * 60; // 10:00 ET
  const activeEnd = 13 * 60; // 13:00 ET
  if (minutesOfDay >= activeStart && minutesOfDay < activeEnd) return "active";
  if (minutesOfDay < activeStart) return "prep";
  void prepStart;
  return "closed";
}

/** Deterministic gate: the scoring engine calls this before ever emitting a
 * new (non-WATCH) day-trade idea. Nothing upstream — including the LLM — can
 * override it. */
export function canIssueNewDayTradeSignal(date: Date = new Date()): boolean {
  return getDaySessionPhase(date) === "active";
}

export function minutesUntilActiveWindow(date: Date = new Date()): number {
  const { hour, minute } = nyParts(date);
  const minutesOfDay = hour * 60 + minute;
  const activeStart = 10 * 60;
  if (minutesOfDay >= activeStart) return 0;
  return activeStart - minutesOfDay;
}

export function minutesRemainingInActiveWindow(date: Date = new Date()): number {
  if (getDaySessionPhase(date) !== "active") return 0;
  const { hour, minute } = nyParts(date);
  const minutesOfDay = hour * 60 + minute;
  return 13 * 60 - minutesOfDay;
}

export function nyNowLabel(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}
