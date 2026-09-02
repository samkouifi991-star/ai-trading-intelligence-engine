import { computeAllCurrencyStrength } from "../scoring/currencyStrength";
import { saveCurrencyStrength } from "../db/currencyStrength";
import { setCached } from "../cache/cache";

/** One ingestion tick: computes all 8 currencies' strength scores, persists
 * each to history (audit/backtesting), and refreshes the cache layer so the
 * dashboard never has to recompute or re-scan history on a page load. */
export async function ingestCurrencyStrength(): Promise<{ currency: string; strengthScore: number }[]> {
  const results = await computeAllCurrencyStrength();
  for (const r of results) {
    await saveCurrencyStrength({ currency: r.currency, strengthScore: r.strengthScore, components: r.components });
    await setCached(`currency_strength:${r.currency}`, { strengthScore: r.strengthScore, components: r.components });
  }
  await setCached(
    "currency_strength:all",
    results.map((r) => ({ currency: r.currency, strengthScore: r.strengthScore }))
  );
  return results.map((r) => ({ currency: r.currency, strengthScore: r.strengthScore }));
}
