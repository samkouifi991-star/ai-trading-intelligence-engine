export type AppMode = "development" | "production";

export function getAppMode(): AppMode {
  const raw = (process.env.APP_MODE || "development").toLowerCase().trim();
  return raw === "production" ? "production" : "development";
}

export function isProductionMode(): boolean {
  return getAppMode() === "production";
}

/**
 * Thrown by a live connector when a real fetch fails in production mode,
 * instead of silently substituting sample data. Sample data is a
 * development/testing convenience only — see the spec's rule 5: "sample
 * data may never create a production trade." Callers (day/swing engines)
 * catch this per-instrument and mark that evaluation NO_TRADE with an
 * explicit "data unavailable" reason rather than scoring on fabricated
 * inputs.
 */
export class DataUnavailableError extends Error {
  constructor(public readonly sourceKey: string, public readonly cause: unknown) {
    super(`Data unavailable for ${sourceKey} in production mode: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DataUnavailableError";
  }
}
