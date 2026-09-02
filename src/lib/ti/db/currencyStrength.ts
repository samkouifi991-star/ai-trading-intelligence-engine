import { getSql } from "./client";

export interface CurrencyStrengthComponents {
  economic: { score: number; status: "available" | "not_available_yet"; sampleSize: number };
  news: { score: number; status: "available" | "not_available_yet" };
  centralBank: { score: number; status: "available" | "not_available_yet" };
  yield: { score: number; status: "available" | "not_available_yet"; detail: string };
  risk: { score: number; status: "available" | "not_available_yet"; detail: string };
  priceAction: { score: number; status: "available" | "not_available_yet"; pairsUsed: string[] };
}

export interface CurrencyStrengthResult {
  currency: string;
  strengthScore: number;
  components: CurrencyStrengthComponents;
  computedAtUtc: Date;
}

export async function saveCurrencyStrength(r: Omit<CurrencyStrengthResult, "computedAtUtc">): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO trading_intel.currency_strength
      (currency, strength_score, economic_component, news_component, central_bank_component, yield_component, risk_component, price_action_component, components_json)
    VALUES
      (${r.currency}, ${r.strengthScore}, ${r.components.economic.score}, ${r.components.news.score}, ${r.components.centralBank.score},
       ${r.components.yield.score}, ${r.components.risk.score}, ${r.components.priceAction.score}, ${sql.json(r.components as any)})
  `;
}

interface CurrencyStrengthRow {
  currency: string;
  strengthScore: string;
  componentsJson: CurrencyStrengthComponents;
  computedAtUtc: Date;
}

/** The dashboard's read path: one query for ALL 8 currencies' most recent
 * row (via DISTINCT ON), never 8 separate round trips and never a scan of
 * the whole history table. */
export async function getLatestCurrencyStrengthAll(): Promise<CurrencyStrengthResult[]> {
  const sql = getSql();
  const rows = await sql<CurrencyStrengthRow[]>`
    SELECT DISTINCT ON (currency) currency, strength_score, components_json, computed_at_utc
    FROM trading_intel.currency_strength
    ORDER BY currency, computed_at_utc DESC
  `;
  return rows.map((r) => ({
    currency: r.currency,
    strengthScore: Number(r.strengthScore),
    components: r.componentsJson,
    computedAtUtc: r.computedAtUtc,
  }));
}
