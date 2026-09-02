import { CURRENCIES, instrumentsForCurrency, type Currency } from "../universe";
import { getRecentSurprisesForCurrency } from "../db/economicSurprises";
import { getAllMarketPrices } from "../db/marketPrices";
import { getMarketDataConnector } from "../../ingestion/marketData";
import { getConnectorHealthFor } from "../../ingestion/connectorHealth";
import type { CurrencyStrengthComponents, CurrencyStrengthResult } from "../db/currencyStrength";
import type { MarketPriceSnapshot } from "../db/marketPrices";
import type { MacroSnapshot } from "../../types";

/** getMacroSnapshot() (reused from the Day/Swing engine's market-data
 * adapter — see ingestion/marketData.ts) can itself silently fall back to
 * sample data per-field in development mode; that fallback is recorded in
 * the OLD system's SQLite connector_health table, invisible to this new
 * Postgres-backed system unless checked explicitly. Never trust a macro
 * field as "available" without confirming its actual source first. */
function isFieldGenuinelyLive(sourceKey: string): boolean {
  const health = getConnectorHealthFor(sourceKey);
  return health?.status === "live" || health?.status === "partial";
}

const HAVEN_CURRENCIES = new Set(["USD", "JPY", "CHF"]);
const RISK_LINKED_CURRENCIES = new Set(["AUD", "NZD", "CAD"]);

// Documented approximations, not calibrated models — see ratePressure.ts's
// SCALE for the same pattern elsewhere in this codebase. Chosen so a
// genuinely large daily move reads clearly significant without pinning at
// +/-100 for an ordinary one.
const PRICE_ACTION_SCALE = 80; // %/day -> -100..100
const VIX_RISK_SCALE = 7; // VIX %change/day -> -100..100
const YIELD_SCALE = 10; // bps/day -> -100..100

function clamp100(n: number): number {
  return Math.max(-100, Math.min(100, n));
}

/**
 * Recency-weighted average, exported for unit testing without a live DB
 * connection: a release from an hour ago should count more than one from 3
 * days ago, without a hard cliff (that's the news decay engine's job in
 * Phase 2; this is a simple, honestly-documented interim). Weight floors at
 * 0.1 rather than 0 so a 72h-old release still counts a little, not nothing.
 */
export function weightedRecencyAverage(rows: { currencyScore: number; ageHours: number }[]): number {
  if (rows.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of rows) {
    const weight = Math.max(0.1, 1 - r.ageHours / 72);
    weightedSum += r.currencyScore * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? clamp100(weightedSum / totalWeight) : 0;
}

async function computeEconomicComponent(currency: string): Promise<CurrencyStrengthComponents["economic"]> {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  const rows = await getRecentSurprisesForCurrency(currency, since);
  if (rows.length === 0) return { score: 0, status: "not_available_yet", sampleSize: 0 };

  const now = Date.now();
  const score = weightedRecencyAverage(
    rows.map((r) => ({ currencyScore: r.currencyScore, ageHours: (now - r.computedAtUtc.getTime()) / 3600_000 }))
  );
  return { score: Math.round(score), status: "available", sampleSize: rows.length };
}

/** Pure — exported for unit testing without a live DB connection. */
export function computePriceActionComponent(currency: Currency, prices: MarketPriceSnapshot[]): CurrencyStrengthComponents["priceAction"] {
  const priceByCurrency = new Map(prices.map((p) => [p.symbol, p]));
  const relevant = instrumentsForCurrency(currency);
  const contributions: number[] = [];
  const pairsUsed: string[] = [];

  for (const instrument of relevant) {
    const price = priceByCurrency.get(instrument.symbol);
    // Sample-fallback prices (development mode, live fetch failed) never
    // feed a real score — same "never mix sample and live without
    // exclusion" rule as the risk/yield components above.
    if (!price || price.changePct === null || price.provider === "sample") continue;
    const direction = instrument.base === currency ? 1 : -1;
    contributions.push(direction * price.changePct);
    pairsUsed.push(instrument.symbol);
  }

  if (contributions.length === 0) return { score: 0, status: "not_available_yet", pairsUsed: [] };
  const avgChangePct = contributions.reduce((a, b) => a + b, 0) / contributions.length;
  return { score: Math.round(clamp100(avgChangePct * PRICE_ACTION_SCALE)), status: "available", pairsUsed };
}

/** Pure — exported for unit testing without a live DB connection.
 * `vixIsLive` is looked up by the caller (computeCurrencyStrength) via
 * isFieldGenuinelyLive so this function itself needs no DB access. */
export function computeRiskComponent(currency: Currency, vixChangePct: number | null, vixIsLive: boolean): CurrencyStrengthComponents["risk"] {
  if (vixChangePct === null) return { score: 0, status: "not_available_yet", detail: "VIX unavailable this tick." };
  if (!vixIsLive) {
    return { score: 0, status: "not_available_yet", detail: "VIX's last fetch was sample/fallback data, not live — not used for scoring." };
  }
  if (!HAVEN_CURRENCIES.has(currency) && !RISK_LINKED_CURRENCIES.has(currency)) {
    return { score: 0, status: "not_available_yet", detail: `${currency} is not classified as a clear safe-haven or risk-linked currency.` };
  }
  const havenSign = HAVEN_CURRENCIES.has(currency) ? 1 : -1;
  const score = Math.round(clamp100(havenSign * vixChangePct * VIX_RISK_SCALE));
  const label = HAVEN_CURRENCIES.has(currency) ? "safe-haven" : "risk-linked";
  return { score, status: "available", detail: `VIX ${vixChangePct > 0 ? "+" : ""}${vixChangePct.toFixed(2)}% today; ${currency} is ${label}.` };
}

/** Pure — exported for unit testing without a live DB connection.
 * `yieldIsLive` is looked up by the caller (computeCurrencyStrength). */
export function computeYieldComponent(
  currency: Currency,
  us2yBpsChange: number | null,
  us10yBpsChange: number | null,
  yieldIsLive: boolean
): CurrencyStrengthComponents["yield"] {
  // Only USD has a real wired yield source right now (FRED daily 2Y/10Y).
  // Every other currency's sovereign-yield feed is a real, separate data
  // source this app doesn't have wired yet — never fabricated as a
  // proxy/estimate (spec rule 4).
  if (currency !== "USD" || us2yBpsChange === null || us10yBpsChange === null) {
    return { score: 0, status: "not_available_yet", detail: `No live sovereign-yield feed wired for ${currency} yet.` };
  }
  if (!yieldIsLive) {
    return { score: 0, status: "not_available_yet", detail: "FRED's last fetch failed — not scoring on stale/unavailable yield data." };
  }
  const avgBps = (us2yBpsChange + us10yBpsChange) / 2;
  return { score: Math.round(clamp100(avgBps * YIELD_SCALE)), status: "available", detail: `US 2Y ${us2yBpsChange > 0 ? "+" : ""}${us2yBpsChange}bp, 10Y ${us10yBpsChange > 0 ? "+" : ""}${us10yBpsChange}bp today.` };
}

const COMPONENT_WEIGHTS = { economic: 0.4, priceAction: 0.3, risk: 0.2, yield: 0.1 } as const;
type ComponentKey = keyof typeof COMPONENT_WEIGHTS;

/**
 * Renormalizes a weighted average over only the components that are
 * actually available this tick (spec rule 4: never blend an unavailable
 * component in as a fake neutral 0, which would just dilute every
 * currency's score toward zero). Exported for unit testing without a live
 * DB connection.
 */
export function combineWeightedComponents(available: { key: ComponentKey; score: number }[]): number {
  const totalWeight = available.reduce((sum, c) => sum + COMPONENT_WEIGHTS[c.key], 0);
  if (totalWeight === 0) return 0;
  return Math.round(clamp100(available.reduce((sum, c) => sum + c.score * COMPONENT_WEIGHTS[c.key], 0) / totalWeight));
}

/**
 * Computes one currency's -100..100 strength score from every component
 * this build genuinely has wired (Phase 1: economic surprises, live price
 * action, VIX-driven risk sentiment, and USD's real yield feed). News and
 * central-bank components are structurally present (Phase 2/3 will
 * populate them) but explicitly marked not_available_yet and excluded from
 * the weighted average — never silently blended in as a fake neutral 0,
 * which would just dilute the score toward zero for every currency.
 *
 * `prices`/`macro` are shared inputs computed once per ingestion tick by
 * computeAllCurrencyStrength (not re-fetched per currency) — 8 currencies
 * sharing one market-data snapshot instead of 8 redundant fetches/queries.
 */
export async function computeCurrencyStrength(
  currency: Currency,
  prices: MarketPriceSnapshot[],
  macro: MacroSnapshot | null
): Promise<CurrencyStrengthResult> {
  const economic = await computeEconomicComponent(currency);
  const priceAction = computePriceActionComponent(currency, prices);
  const risk = computeRiskComponent(currency, macro?.vixChangePct ?? null, isFieldGenuinelyLive("marketData:VIX"));
  const yieldComponent = computeYieldComponent(
    currency,
    macro?.us2yDailyChangeBps ?? null,
    macro?.us10yDailyChangeBps ?? null,
    isFieldGenuinelyLive("marketData:FRED_DGS2") && isFieldGenuinelyLive("marketData:FRED_DGS10")
  );

  const available: { key: ComponentKey; score: number }[] = [];
  if (economic.status === "available") available.push({ key: "economic", score: economic.score });
  if (priceAction.status === "available") available.push({ key: "priceAction", score: priceAction.score });
  if (risk.status === "available") available.push({ key: "risk", score: risk.score });
  if (yieldComponent.status === "available") available.push({ key: "yield", score: yieldComponent.score });

  const strengthScore = combineWeightedComponents(available);

  return {
    currency,
    strengthScore,
    components: {
      economic,
      priceAction,
      risk,
      yield: yieldComponent,
      news: { score: 0, status: "not_available_yet" },
      centralBank: { score: 0, status: "not_available_yet" },
    },
    computedAtUtc: new Date(),
  };
}

export async function computeAllCurrencyStrength(): Promise<CurrencyStrengthResult[]> {
  const [prices, macro] = await Promise.all([
    getAllMarketPrices(),
    getMarketDataConnector().connector.getMacroSnapshot().catch(() => null),
  ]);
  return Promise.all(CURRENCIES.map((c) => computeCurrencyStrength(c, prices, macro)));
}
