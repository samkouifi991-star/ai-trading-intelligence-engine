/**
 * Lightweight assertion-based tests for the deterministic engines — the part
 * of this system the design explicitly requires to be correct and auditable
 * independent of any LLM call. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { dayDecayFactor, swingDecayFactor } from "../src/lib/news/decay";
import { computeDayTradeScore, classifyScore } from "../src/lib/scoring/dayTradeScore";
import { computeSwingScore } from "../src/lib/scoring/swingScore";
import { decideFinalStatus } from "../src/lib/signals/validation";
import { rankOpportunities } from "../src/lib/scoring/rank";
import { getDaySessionPhase } from "../src/lib/time/session";
import { mapFairEconomyRow, parseFeedNumber } from "../src/lib/ingestion/forexFactoryCalendar";
import { parseFredCsv } from "../src/lib/ingestion/marketData";
import { parseYahooChartResponse } from "../src/lib/marketdata/providers/yahoo";
import { computeRatePressure } from "../src/lib/marketdata/ratePressure";
import { mapRssItem } from "../src/lib/ingestion/forexFactoryNews";
import { parseForexFactoryNewsHtml } from "../src/lib/ingestion/forexFactoryNewsDirect";
import { buildReactionReport } from "../src/lib/pipeline/eventClock";
import { saveEventClockSnapshot, upsertNewsStory } from "../src/lib/db/repository";
import type { NewsStory, TradeSignal } from "../src/lib/types";
import { computeSurpriseCurrencyScore, resolveDirectionality } from "../src/lib/ti/scoring/surpriseEngine";
import {
  weightedRecencyAverage,
  computePriceActionComponent,
  computeRiskComponent,
  computeYieldComponent,
  combineWeightedComponents,
} from "../src/lib/ti/scoring/currencyStrength";
import type { EconomicEvent } from "../src/lib/types";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    console.error(`  FAIL — ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("news decay curve");
test("day decay at t=0 is 100%", () => assert.equal(dayDecayFactor(0), 1.0));
test("day decay at t=10min is between 90-100%", () => {
  const v = dayDecayFactor(10);
  assert.ok(v > 0.9 && v <= 1.0, `got ${v}`);
});
test("day decay at t=45min is between 45-70%", () => {
  const v = dayDecayFactor(45);
  assert.ok(v >= 0.45 && v <= 0.7, `got ${v}`);
});
test("day decay at t=90min is between 25-45%", () => {
  const v = dayDecayFactor(90);
  assert.ok(v >= 0.25 && v <= 0.45, `got ${v}`);
});
test("day decay strictly decreases over time", () => {
  assert.ok(dayDecayFactor(5) > dayDecayFactor(60));
  assert.ok(dayDecayFactor(60) > dayDecayFactor(240));
});
test("swing decay is much slower than day decay at 2 hours", () => {
  assert.ok(swingDecayFactor(2 / 24) > dayDecayFactor(120));
});

console.log("\nday-trade composite scoring");
test("weights sum to a 0-100 composite with equal 100 inputs", () => {
  const { composite } = computeDayTradeScore({
    newsCatalystScore: 100,
    economicSurpriseScore: 100,
    crossMarketConfirmationScore: 100,
    technicalScore: 100,
    marketRegimeScore: 100,
  });
  assert.equal(composite, 100);
});
test("classification bands match spec", () => {
  assert.equal(classifyScore(95), "Exceptional");
  assert.equal(classifyScore(85), "Strong");
  assert.equal(classifyScore(75), "Watch");
  assert.equal(classifyScore(50), "No Trade");
});
test("news catalyst (35%) dominates over regime (10%)", () => {
  const highNews = computeDayTradeScore({
    newsCatalystScore: 100,
    economicSurpriseScore: 0,
    crossMarketConfirmationScore: 0,
    technicalScore: 0,
    marketRegimeScore: 0,
  }).composite;
  const highRegime = computeDayTradeScore({
    newsCatalystScore: 0,
    economicSurpriseScore: 0,
    crossMarketConfirmationScore: 0,
    technicalScore: 0,
    marketRegimeScore: 100,
  }).composite;
  assert.ok(highNews > highRegime);
});

console.log("\nswing composite scoring");
test("weights sum to a 0-100 composite with equal 100 inputs", () => {
  const { composite } = computeSwingScore({
    macroRegimeScore: 100,
    centralBankOutlookScore: 100,
    fundamentalTrendScore: 100,
    geopoliticalThemeScore: 100,
    technicalTrendScore: 100,
    positioningFlowsScore: 100,
  });
  assert.equal(composite, 100);
});

console.log("\ndeterministic validation gate (the LLM never decides TRADE/WATCH/NO_TRADE)");
test("score < 70 is always NO_TRADE", () => {
  const { finalStatus } = decideFinalStatus({
    engine: "SWING",
    breakdown: computeSwingScore({
      macroRegimeScore: 50,
      centralBankOutlookScore: 50,
      fundamentalTrendScore: 50,
      geopoliticalThemeScore: 50,
      technicalTrendScore: 50,
      positioningFlowsScore: 50,
    }),
    crossAssetContradicted: false,
    dataQualityScore: 100,
  });
  assert.equal(finalStatus, "NO_TRADE");
});
test("score >= 80 with contradicted cross-asset confirmation is forced NO_TRADE, never TRADE", () => {
  const { finalStatus } = decideFinalStatus({
    engine: "SWING",
    breakdown: computeSwingScore({
      macroRegimeScore: 100,
      centralBankOutlookScore: 100,
      fundamentalTrendScore: 100,
      geopoliticalThemeScore: 100,
      technicalTrendScore: 100,
      positioningFlowsScore: 100,
    }),
    crossAssetContradicted: true,
    dataQualityScore: 100,
  });
  assert.equal(finalStatus, "NO_TRADE");
});
test("DAY engine score >= 80 outside the 10:00-13:00 ET window downgrades to WATCH, never TRADE", () => {
  const outsideWindow = new Date("2026-08-31T08:00:00-04:00"); // 08:00 ET, prep phase
  assert.equal(getDaySessionPhase(outsideWindow), "prep");
  const { finalStatus } = decideFinalStatus({
    engine: "DAY",
    breakdown: computeDayTradeScore({
      newsCatalystScore: 100,
      economicSurpriseScore: 100,
      crossMarketConfirmationScore: 100,
      technicalScore: 100,
      marketRegimeScore: 100,
    }),
    crossAssetContradicted: false,
    dataQualityScore: 100,
    now: outsideWindow,
  });
  assert.equal(finalStatus, "WATCH");
});
test("DAY engine score >= 80 inside the 10:00-13:00 ET window with confirmation is TRADE", () => {
  const insideWindow = new Date("2026-08-31T11:00:00-04:00"); // 11:00 ET, active phase
  assert.equal(getDaySessionPhase(insideWindow), "active");
  const { finalStatus } = decideFinalStatus({
    engine: "DAY",
    breakdown: computeDayTradeScore({
      newsCatalystScore: 100,
      economicSurpriseScore: 100,
      crossMarketConfirmationScore: 100,
      technicalScore: 100,
      marketRegimeScore: 100,
    }),
    crossAssetContradicted: false,
    dataQualityScore: 100,
    now: insideWindow,
  });
  assert.equal(finalStatus, "TRADE");
});

console.log("\ndata quality gating (spec rule 6 — a 92 composite must not TRADE on 45/100 data quality)");
test("data quality < 60 forces NO_TRADE even with a perfect composite score", () => {
  const perfect = computeSwingScore({
    macroRegimeScore: 100,
    centralBankOutlookScore: 100,
    fundamentalTrendScore: 100,
    geopoliticalThemeScore: 100,
    technicalTrendScore: 100,
    positioningFlowsScore: 100,
  });
  const { finalStatus } = decideFinalStatus({ engine: "SWING", breakdown: perfect, crossAssetContradicted: false, dataQualityScore: 45 });
  assert.equal(finalStatus, "NO_TRADE");
});
test("data quality 60-74 forces WATCH even with a perfect composite score", () => {
  const perfect = computeSwingScore({
    macroRegimeScore: 100,
    centralBankOutlookScore: 100,
    fundamentalTrendScore: 100,
    geopoliticalThemeScore: 100,
    technicalTrendScore: 100,
    positioningFlowsScore: 100,
  });
  const { finalStatus } = decideFinalStatus({ engine: "SWING", breakdown: perfect, crossAssetContradicted: false, dataQualityScore: 65 });
  assert.equal(finalStatus, "WATCH");
});
test("data quality 75-89 applies a confidence penalty but doesn't force a status", () => {
  const perfect = computeSwingScore({
    macroRegimeScore: 100,
    centralBankOutlookScore: 100,
    fundamentalTrendScore: 100,
    geopoliticalThemeScore: 100,
    technicalTrendScore: 100,
    positioningFlowsScore: 100,
  });
  const { finalStatus, adjustedConfidence } = decideFinalStatus({
    engine: "SWING",
    breakdown: perfect,
    crossAssetContradicted: false,
    dataQualityScore: 80,
  });
  assert.ok(adjustedConfidence < perfect.composite, `expected penalty to reduce ${perfect.composite}, got ${adjustedConfidence}`);
  assert.equal(finalStatus, "TRADE"); // still qualifies even after the mild penalty since it started at 100
});

console.log("\nintraday Treasury rate-pressure proxy (ZT/ZN futures, replaces FRED for Day-engine confirmation)");
test("Treasury futures price DOWN reads as hawkish (positive) pressure", () => {
  assert.ok(computeRatePressure(-0.15) > 15, "a falling futures price should read hawkish");
});
test("Treasury futures price UP reads as dovish (negative) pressure", () => {
  assert.ok(computeRatePressure(0.15) < -15, "a rising futures price should read dovish");
});
test("rate pressure clamps to +/-100", () => {
  assert.equal(computeRatePressure(-5), 100);
  assert.equal(computeRatePressure(5), -100);
});

console.log("\ndirect Forex Factory news scraper (parser logic only — see forexFactoryNewsDirect.ts");
console.log("for why real forexfactory.com markup can't be verified from this sandbox)");
test("parseForexFactoryNewsHtml extracts headline/time/impact/currency/summary from a news-list row", () => {
  const html = `<html><body><ul>
    <li class="flexposts__item flexposts__item--impact-high">
      <div class="flexposts__impact"><span class="impact-icon-high"></span></div>
      <div class="flexposts__currency" title="USD">USD</div>
      <a class="flexposts__title" href="/news/12345-fed-chair-says-additional-hikes-may-be-needed">Fed Chair says additional hikes may be needed</a>
      <time datetime="2026-08-31T14:32:00Z">2h</time>
      <p class="flexposts__excerpt">The Federal Reserve chair signaled openness to further tightening.</p>
    </li>
  </ul></body></html>`;
  const items = parseForexFactoryNewsHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].headline, "Fed Chair says additional hikes may be needed");
  assert.equal(items[0].ffImpact, "high");
  assert.equal(items[0].relatedCurrency, "USD");
  assert.equal(items[0].timestampUtc, "2026-08-31T14:32:00.000Z");
  assert.equal(items[0].url, "https://www.forexfactory.com/news/12345-fed-chair-says-additional-hikes-may-be-needed");
  assert.ok(items[0].body?.includes("tightening"));
  assert.equal(items[0].contentType, "verified_news");
});
test("parseForexFactoryNewsHtml returns an empty array (not a crash) on unrecognized markup", () => {
  const items = parseForexFactoryNewsHtml("<html><body><p>completely different page structure</p></body></html>");
  assert.equal(items.length, 0);
});

console.log("\nEvent Clock: prediction vs. confirmation reconciliation");
test("buildReactionReport confirms a predicted move when the actual price change agrees in sign", () => {
  const storyId = `test-story-${Date.now()}`;
  const t0 = new Date().toISOString();

  const story: NewsStory = {
    storyId,
    clusterKeyTerms: [],
    headlines: [],
    firstSeenUtc: t0,
    lastUpdatedUtc: t0,
    developmentCount: 1,
    tradingHorizon: "day",
    latestAnalysis: {
      storyId,
      timestampUtc: t0,
      headline: "test hawkish CPI",
      originalSource: "test",
      sourceQuality: 90,
      affectedCountries: [],
      affectedCurrencies: [],
      affectedCommodities: [],
      affectedIndices: [],
      eventType: "economic_data",
      sourceAttribution: null,
      confirmed: true,
      novelty: "new_story",
      severity: 80,
      confidence: 80,
      expectedDurationMinutes: 60,
      inflationImpact: "higher",
      growthImpact: "neutral",
      interestRateImpact: "hawkish",
      riskImpact: "neutral",
      expectedAssetImpact: [{ symbol: "XAUUSD", score: -80 }], // predicted bearish gold
      causalChain: [],
    },
  };
  upsertNewsStory(story);
  saveEventClockSnapshot({ storyId, t0Utc: t0, checkpoint: "T0", symbol: "XAUUSD", price: 2650 });
  saveEventClockSnapshot({ storyId, t0Utc: t0, checkpoint: "T+5m", symbol: "XAUUSD", price: 2634 }); // -0.6%, bearish

  const report = buildReactionReport(story);
  const xau = report.confirmations.find((c) => c.symbol === "XAUUSD");
  assert.ok(xau, "expected a confirmation entry for XAUUSD");
  assert.equal(xau!.confirmed, true, "predicted -80 and actual -0.6% agree in sign, should confirm");
});
test("buildReactionReport does NOT confirm when actual price moves opposite the prediction", () => {
  const storyId = `test-story-contra-${Date.now()}`;
  const t0 = new Date().toISOString();

  const story: NewsStory = {
    storyId,
    clusterKeyTerms: [],
    headlines: [],
    firstSeenUtc: t0,
    lastUpdatedUtc: t0,
    developmentCount: 1,
    tradingHorizon: "day",
    latestAnalysis: {
      storyId,
      timestampUtc: t0,
      headline: "test hawkish CPI",
      originalSource: "test",
      sourceQuality: 90,
      affectedCountries: [],
      affectedCurrencies: [],
      affectedCommodities: [],
      affectedIndices: [],
      eventType: "economic_data",
      sourceAttribution: null,
      confirmed: true,
      novelty: "new_story",
      severity: 80,
      confidence: 80,
      expectedDurationMinutes: 60,
      inflationImpact: "higher",
      growthImpact: "neutral",
      interestRateImpact: "hawkish",
      riskImpact: "neutral",
      expectedAssetImpact: [{ symbol: "XAUUSD", score: -80 }], // predicted bearish gold
      causalChain: [],
    },
  };
  upsertNewsStory(story);
  saveEventClockSnapshot({ storyId, t0Utc: t0, checkpoint: "T0", symbol: "XAUUSD", price: 2650 });
  saveEventClockSnapshot({ storyId, t0Utc: t0, checkpoint: "T+5m", symbol: "XAUUSD", price: 2666 }); // +0.6%, bullish

  const report = buildReactionReport(story);
  const xau = report.confirmations.find((c) => c.symbol === "XAUUSD");
  assert.ok(xau);
  assert.equal(xau!.confirmed, false, "predicted -80 but actual +0.6% disagrees, should NOT confirm");
});

console.log("\nopportunity ranking / correlation de-duplication");
test("a lower-ranked correlated instrument (ES vs NQ) is suppressed", () => {
  const base: Omit<TradeSignal, "id" | "instrument" | "confidence"> = {
    engine: "DAY",
    direction: "SHORT",
    catalyst: "test",
    newsSummary: "test",
    newsImpactScore: null,
    marketConfirmationScore: null,
    economicSurpriseScore: null,
    fundamentalScore: null,
    technicalScore: null,
    crossMarketConfirmationScore: null,
    marketRegimeScore: null,
    dataQualityScore: 100,
    dataQualityReason: null,
    usesSampleData: false,
    provenance: [],
    entryZone: null,
    invalidation: null,
    target1: null,
    target2: null,
    expectedHoldingPeriod: "Intraday",
    timestampUtc: new Date().toISOString(),
    signalExpirationUtc: new Date().toISOString(),
    reasonsFor: [],
    reasonsAgainst: [],
    upcomingRisks: [],
    finalStatus: "TRADE",
    scoreBreakdown: computeDayTradeScore({
      newsCatalystScore: 90,
      economicSurpriseScore: 90,
      crossMarketConfirmationScore: 90,
      technicalScore: 90,
      marketRegimeScore: 90,
    }),
    storyId: null,
  };
  const es: TradeSignal = { ...base, id: "1", instrument: "ES", confidence: 91 };
  const nq: TradeSignal = { ...base, id: "2", instrument: "NQ", confidence: 84 };
  const eur: TradeSignal = { ...base, id: "3", instrument: "EURUSD", confidence: 78 };
  const { ranked, suppressed } = rankOpportunities([nq, es, eur]);
  assert.deepEqual(ranked.map((r) => r.signal.instrument), ["ES", "EURUSD"]);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].signal.instrument, "NQ");
});

console.log("\nreal-data parsers (fixture-verified — live network is blocked in this dev sandbox by org egress");
console.log("policy, so these prove parsing correctness against each API's real documented/observed schema)");

test("parseFeedNumber handles FF calendar's unit suffixes", () => {
  assert.equal(parseFeedNumber("180K"), 180000);
  assert.equal(parseFeedNumber("3.2%"), 3.2);
  assert.equal(parseFeedNumber("-1.5M"), -1500000);
  assert.equal(parseFeedNumber(""), null);
  assert.equal(parseFeedNumber("  "), null);
  assert.equal(parseFeedNumber("4.50%-4.75%"), 4.625);
  assert.equal(parseFeedNumber("<0.1%"), 0.1);
});

test("mapFairEconomyRow parses a realistic faireconomy.media calendar row", () => {
  const row = {
    title: "Non-Farm Payrolls",
    country: "USD",
    date: "2026-09-05T08:30:00-04:00",
    impact: "High",
    forecast: "180K",
    previous: "175K",
    actual: "187K",
  };
  const event = mapFairEconomyRow(row);
  assert.ok(event);
  assert.equal(event!.event, "Non-Farm Payrolls");
  assert.equal(event!.currency, "USD");
  assert.equal(event!.impact, "high");
  assert.equal(event!.actual, 187000);
  assert.equal(event!.forecast, 180000);
  assert.equal(event!.previous, 175000);
  assert.equal(event!.revisedPrevious, null);
  assert.equal(new Date(event!.eventTimeUtc).toISOString(), event!.eventTimeUtc);
});

test("mapFairEconomyRow handles a non-numeric/holiday row without throwing", () => {
  const row = { title: "Bank Holiday", country: "USD", date: "2026-09-07T00:00:00-04:00", impact: "Holiday", forecast: "", previous: "", actual: "" };
  const event = mapFairEconomyRow(row);
  assert.ok(event);
  assert.equal(event!.actual, null);
  assert.equal(event!.forecast, null);
  assert.equal(event!.impact, "low"); // unrecognized impact string falls back to low, never crashes
});

test("mapFairEconomyRow returns null for a row missing required fields", () => {
  assert.equal(mapFairEconomyRow({ title: "No date given", country: "USD" }), null);
});

test("parseYahooChartResponse parses a realistic chart response and drops null-padded gap bars", () => {
  const fixture = {
    chart: {
      result: [
        {
          meta: { currency: "USD", symbol: "^GSPC", regularMarketPrice: 5712.34, previousClose: 5700.11 },
          timestamp: [1735689600, 1735689660, 1735689720],
          indicators: {
            quote: [
              {
                open: [5700.5, null, 5705.2],
                high: [5701.0, null, 5706.0],
                low: [5699.8, null, 5704.5],
                close: [5700.9, null, 5705.8],
                volume: [1200, null, 1500],
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
  const result = parseYahooChartResponse(fixture, "^GSPC");
  assert.equal(result.last, 5712.34);
  assert.equal(result.previousClose, 5700.11);
  assert.equal(result.bars.length, 2); // the null-padded middle minute is dropped
  assert.equal(result.bars[0].close, 5700.9);
  assert.equal(result.bars[1].close, 5705.8);
});

test("parseYahooChartResponse throws on Yahoo's own error shape", () => {
  const fixture = { chart: { result: null, error: { code: "Not Found", description: "No data found" } } };
  assert.throws(() => parseYahooChartResponse(fixture, "BADSYM"));
});

test("parseFredCsv picks the latest two real observations, skipping '.' (no-release) rows", () => {
  const csv = "DATE,DGS10\n2026-08-25,4.15\n2026-08-26,4.12\n2026-08-27,.\n2026-08-28,4.18\n";
  const { latest, previous } = parseFredCsv(csv);
  assert.equal(latest.date, "2026-08-28");
  assert.equal(latest.value, 4.18);
  assert.equal(previous.date, "2026-08-26");
  assert.equal(previous.value, 4.12);
});

test("mapRssItem parses a realistic ForexLive-style RSS item (CDATA, HTML body, pubDate)", () => {
  const item = {
    title: { __cdata: "Fed's Waller says rate cuts not imminent amid sticky inflation" },
    link: "https://www.forexlive.com/News/!/feds-waller-123456",
    pubDate: "Mon, 31 Aug 2026 12:00:00 GMT",
    guid: "https://www.forexlive.com/?p=123456",
    description: { __cdata: "<p>Fed governor Christopher Waller said Monday that rate cuts are <b>not imminent</b> given persistent inflation.</p>" },
  };
  const headline = mapRssItem(item, "ForexLive (real-time forex news wire)");
  assert.ok(headline);
  assert.equal(headline!.headline, "Fed's Waller says rate cuts not imminent amid sticky inflation");
  assert.equal(headline!.source, "ForexLive (real-time forex news wire)");
  assert.equal(headline!.url, "https://www.forexlive.com/News/!/feds-waller-123456");
  assert.ok(!headline!.body!.includes("<"), "HTML tags should be stripped from the body");
  assert.equal(new Date(headline!.timestampUtc).toISOString(), headline!.timestampUtc);
});

test("mapRssItem returns null for an item missing a title or pubDate", () => {
  assert.equal(mapRssItem({ link: "https://x.test" }, "source"), null);
});

console.log("\nTrading Intelligence Engine: Economic Surprise scoring formula");
test("computeSurpriseCurrencyScore: null z scores 0 regardless of directionality", () => {
  assert.equal(computeSurpriseCurrencyScore(null, "hawkish", 1), 0);
});
test("computeSurpriseCurrencyScore: mixed/unclear directionality scores 0 regardless of |z|", () => {
  assert.equal(computeSurpriseCurrencyScore(5, "mixed", 1), 0);
  assert.equal(computeSurpriseCurrencyScore(5, "unclear", 1), 0);
});
test("computeSurpriseCurrencyScore: hawkish z=1 at full impact weight is positive and ~55", () => {
  const score = computeSurpriseCurrencyScore(1, "hawkish", 1);
  assert.ok(score > 50 && score < 60, `got ${score}`);
});
test("computeSurpriseCurrencyScore: dovish z=1 at full impact weight is the negative mirror of hawkish", () => {
  const hawkish = computeSurpriseCurrencyScore(1, "hawkish", 1);
  const dovish = computeSurpriseCurrencyScore(1, "dovish", 1);
  assert.equal(dovish, -hawkish);
});
test("computeSurpriseCurrencyScore: low-impact (0.3 weight) release scores lower magnitude than high-impact (1.0) for the same z", () => {
  const high = Math.abs(computeSurpriseCurrencyScore(2, "hawkish", 1));
  const low = Math.abs(computeSurpriseCurrencyScore(2, "hawkish", 0.3));
  assert.ok(low < high, `low=${low} should be < high=${high}`);
});
test("computeSurpriseCurrencyScore: an enormous surprise clamps at +/-100, never exceeds the spec's scale", () => {
  assert.equal(computeSurpriseCurrencyScore(50, "hawkish", 1), 100);
  assert.equal(computeSurpriseCurrencyScore(50, "dovish", 1), -100);
});

console.log("\nTrading Intelligence Engine: directionality resolution (never actual>forecast=bullish)");
const CPI_EVENT: EconomicEvent = {
  id: "e1", event: "Core CPI m/m", currency: "USD", eventTimeUtc: new Date().toISOString(),
  impact: "high", actual: 0.4, forecast: 0.3, previous: 0.3, revisedPrevious: null,
  source: "Forex Factory Calendar", description: "",
};
const UNEMPLOYMENT_EVENT: EconomicEvent = { ...CPI_EVENT, id: "e2", event: "Unemployment Rate" };
const RETAIL_SALES_EVENT: EconomicEvent = { ...CPI_EVENT, id: "e3", event: "Retail Sales m/m" };

test("resolveDirectionality: null z (no actual/forecast pair) is unclear", () => {
  assert.equal(resolveDirectionality(CPI_EVENT, null, null).directionality, "unclear");
});
test("resolveDirectionality: |z| within the noise band (<0.15) is mixed even for a higher_hawkish indicator", () => {
  assert.equal(resolveDirectionality(CPI_EVENT, 0.1, null).directionality, "mixed");
});
test("resolveDirectionality: CPI beat (higher_hawkish, positive z) reads hawkish", () => {
  assert.equal(resolveDirectionality(CPI_EVENT, 1.2, null).directionality, "hawkish");
});
test("resolveDirectionality: CPI miss (higher_hawkish, negative z) reads dovish", () => {
  assert.equal(resolveDirectionality(CPI_EVENT, -1.2, null).directionality, "dovish");
});
test("resolveDirectionality: Unemployment Rate HIGHER than expected (higher_dovish polarity) reads dovish, not hawkish — never a naive actual>forecast=bullish shortcut", () => {
  assert.equal(resolveDirectionality(UNEMPLOYMENT_EVENT, 1.2, null).directionality, "dovish");
});
test("resolveDirectionality: Unemployment Rate LOWER than expected reads hawkish", () => {
  assert.equal(resolveDirectionality(UNEMPLOYMENT_EVENT, -1.2, null).directionality, "hawkish");
});
test("resolveDirectionality: context_dependent indicator (Retail Sales) with no regime context is mixed, not guessed", () => {
  assert.equal(resolveDirectionality(RETAIL_SALES_EVENT, 1.2, null).directionality, "mixed");
});
test("resolveDirectionality: context_dependent indicator becomes rate-path-relevant only when a hawkish regime is supplied", () => {
  const withRegime = resolveDirectionality(RETAIL_SALES_EVENT, 1.2, "Rate bias: hawkish");
  assert.equal(withRegime.directionality, "hawkish");
});

console.log("\nTrading Intelligence Engine: Currency Strength Engine component formulas");
test("weightedRecencyAverage: empty input scores 0, not a division-by-zero crash", () => {
  assert.equal(weightedRecencyAverage([]), 0);
});
test("weightedRecencyAverage: a single fresh release returns exactly its own score", () => {
  assert.equal(weightedRecencyAverage([{ currencyScore: 42, ageHours: 0 }]), 42);
});
test("weightedRecencyAverage: a fresh release outweighs a stale one of the opposite sign", () => {
  const score = weightedRecencyAverage([
    { currencyScore: 100, ageHours: 0 },
    { currencyScore: -100, ageHours: 70 }, // near the 72h floor, weight bottoms out at 0.1
  ]);
  assert.ok(score > 50, `expected the fresh release to dominate, got ${score}`);
});

const usdPrice = (symbol: string, changePct: number, provider = "yahoo") => ({
  symbol, bid: null, ask: null, last: 1, spread: null, changePct, provider, realtime: false, updatedAtUtc: new Date(),
});

test("computePriceActionComponent: EURUSD rising means USD weakening (USD is the quote currency, so direction flips)", () => {
  const result = computePriceActionComponent("USD" as any, [usdPrice("EURUSD", 0.5)]);
  assert.equal(result.status, "available");
  assert.equal(result.score, Math.round(-0.5 * 80));
  assert.ok(result.score < 0, "EURUSD up should read as USD strength going down");
});
test("computePriceActionComponent: USDJPY rising means USD strengthening (USD is the base currency)", () => {
  const result = computePriceActionComponent("USD" as any, [usdPrice("USDJPY", 0.5)]);
  assert.ok(result.score > 0, "USDJPY up should read as USD strength going up");
});
test("computePriceActionComponent: sample-provider prices are excluded, never silently scored as real", () => {
  const result = computePriceActionComponent("USD" as any, [usdPrice("EURUSD", 0.5, "sample")]);
  assert.equal(result.status, "not_available_yet");
  assert.deepEqual(result.pairsUsed, []);
});
test("computePriceActionComponent: no matching prices at all is not_available_yet, never a fabricated 0-as-real", () => {
  const result = computePriceActionComponent("USD" as any, []);
  assert.equal(result.status, "not_available_yet");
});

test("computeRiskComponent: null VIX change is not_available_yet", () => {
  assert.equal(computeRiskComponent("USD" as any, null, true).status, "not_available_yet");
});
test("computeRiskComponent: VIX's own last fetch being sample data excludes it from scoring even if a number is present", () => {
  assert.equal(computeRiskComponent("USD" as any, 3, false).status, "not_available_yet");
});
test("computeRiskComponent: a currency with no clear haven/risk-linked classification is not_available_yet (EUR is deliberately not guessed)", () => {
  assert.equal(computeRiskComponent("EUR" as any, 3, true).status, "not_available_yet");
});
test("computeRiskComponent: rising VIX (risk-off) is positive for a safe haven (USD)", () => {
  const result = computeRiskComponent("USD" as any, 2, true);
  assert.equal(result.status, "available");
  assert.ok(result.score > 0, `expected positive, got ${result.score}`);
});
test("computeRiskComponent: rising VIX (risk-off) is negative for a risk-linked currency (AUD) — the mirror image of a haven", () => {
  const haven = computeRiskComponent("USD" as any, 2, true).score;
  const riskLinked = computeRiskComponent("AUD" as any, 2, true).score;
  assert.equal(riskLinked, -haven);
});

test("computeYieldComponent: only USD has a real wired feed — every other currency is not_available_yet, never a fabricated proxy", () => {
  assert.equal(computeYieldComponent("EUR" as any, 3, 5, true).status, "not_available_yet");
});
test("computeYieldComponent: USD with a genuinely live FRED fetch scores from the real 2Y/10Y bps change", () => {
  const result = computeYieldComponent("USD" as any, 3, 5, true);
  assert.equal(result.status, "available");
  assert.equal(result.score, Math.round(((3 + 5) / 2) * 10));
});
test("computeYieldComponent: USD but FRED's last fetch failed is not_available_yet, never scored on stale data", () => {
  assert.equal(computeYieldComponent("USD" as any, 3, 5, false).status, "not_available_yet");
});

console.log("\nTrading Intelligence Engine: weighted component combination (renormalizes over what's actually available)");
test("combineWeightedComponents: no available components scores 0, not a division-by-zero crash", () => {
  assert.equal(combineWeightedComponents([]), 0);
});
test("combineWeightedComponents: a single available component is renormalized to its own full weight (its score passes through)", () => {
  assert.equal(combineWeightedComponents([{ key: "economic", score: 50 }]), 50);
});
test("combineWeightedComponents: two components blend proportionally to their relative weights", () => {
  // economic (0.4)=50, priceAction (0.3)=-20 -> (50*0.4 + -20*0.3) / (0.4+0.3) = 20
  const result = combineWeightedComponents([
    { key: "economic", score: 50 },
    { key: "priceAction", score: -20 },
  ]);
  assert.equal(result, 20);
});
test("combineWeightedComponents: clamps to the spec's -100..100 scale even if a component score were out of range", () => {
  assert.equal(combineWeightedComponents([{ key: "economic", score: 500 }]), 100);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("\nSome tests FAILED.");
} else {
  console.log("All tests passed.");
}
