import type { NewsStory } from "../types";

/** Piecewise-linear interpolation through named (x, y) checkpoints. */
function interpolate(x: number, points: [number, number][]): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

// Day-trading catalysts decay fast — matches the spec's starting model.
const DAY_DECAY_CHECKPOINTS: [number, number][] = [
  [0, 1.0],
  [5, 1.0],
  [15, 0.9],
  [30, 0.7],
  [60, 0.45],
  [120, 0.25],
  [240, 0.1],
  [480, 0.03],
];

/** Swing catalysts decay far more slowly — measured in days, not minutes,
 * since a swing thesis is about whether the medium-term narrative changed,
 * not the next hour's price reaction. */
const SWING_DECAY_CHECKPOINTS: [number, number][] = [
  [0, 1.0],
  [1, 0.95], // 1 day
  [3, 0.85],
  [7, 0.7],
  [14, 0.5],
  [30, 0.3],
  [60, 0.12],
  [120, 0.05],
];

export function dayDecayFactor(minutesSinceLastMaterialUpdate: number): number {
  return interpolate(minutesSinceLastMaterialUpdate, DAY_DECAY_CHECKPOINTS);
}

export function swingDecayFactor(daysSinceLastMaterialUpdate: number): number {
  return interpolate(daysSinceLastMaterialUpdate, SWING_DECAY_CHECKPOINTS);
}

/** `lastUpdatedUtc` on a NewsStory is only bumped by the pipeline when a
 * headline is classified `new_story` or `incremental_update` — a
 * `repeat_confirmation` headline gets appended to the story's headline list
 * but does NOT reset the decay clock, per spec ("only genuinely new
 * developments should materially change the story's impact score"). */
export function currentDecayFactor(story: NewsStory, horizon: "day" | "swing", now: Date = new Date()): number {
  const lastUpdate = new Date(story.lastUpdatedUtc).getTime();
  const elapsedMs = now.getTime() - lastUpdate;
  if (horizon === "day") {
    return dayDecayFactor(elapsedMs / 60_000);
  }
  return swingDecayFactor(elapsedMs / 86_400_000);
}

/** Applies decay to a story's raw severity (0-100) to get its currently
 * effective catalyst strength. */
export function decayedSeverity(story: NewsStory, horizon: "day" | "swing", now: Date = new Date()): number {
  return story.latestAnalysis.severity * currentDecayFactor(story, horizon, now);
}
