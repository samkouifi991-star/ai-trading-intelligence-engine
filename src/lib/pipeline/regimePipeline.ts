import { getMarketDataConnector } from "../ingestion/marketData";
import { computeMacroRegime } from "../regime/regimeEngine";
import type { MacroRegime } from "../types";

export async function getCurrentRegime(): Promise<{ regime: MacroRegime; mode: "live" | "sample" }> {
  const { connector, mode } = getMarketDataConnector();
  const macro = await connector.getMacroSnapshot();
  return { regime: computeMacroRegime(macro), mode };
}
