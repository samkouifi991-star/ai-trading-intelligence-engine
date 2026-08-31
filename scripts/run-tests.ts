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
import { parseYahooChartResponse, parseFredCsv } from "../src/lib/ingestion/marketData";
import { mapRssItem } from "../src/lib/ingestion/forexFactoryNews";
import type { TradeSignal } from "../src/lib/types";

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
  const status = decideFinalStatus({
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
  });
  assert.equal(status, "NO_TRADE");
});
test("score >= 80 with contradicted cross-asset confirmation is forced NO_TRADE, never TRADE", () => {
  const status = decideFinalStatus({
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
  });
  assert.equal(status, "NO_TRADE");
});
test("DAY engine score >= 80 outside the 10:00-13:00 ET window downgrades to WATCH, never TRADE", () => {
  const outsideWindow = new Date("2026-08-31T08:00:00-04:00"); // 08:00 ET, prep phase
  assert.equal(getDaySessionPhase(outsideWindow), "prep");
  const status = decideFinalStatus({
    engine: "DAY",
    breakdown: computeDayTradeScore({
      newsCatalystScore: 100,
      economicSurpriseScore: 100,
      crossMarketConfirmationScore: 100,
      technicalScore: 100,
      marketRegimeScore: 100,
    }),
    crossAssetContradicted: false,
    now: outsideWindow,
  });
  assert.equal(status, "WATCH");
});
test("DAY engine score >= 80 inside the 10:00-13:00 ET window with confirmation is TRADE", () => {
  const insideWindow = new Date("2026-08-31T11:00:00-04:00"); // 11:00 ET, active phase
  assert.equal(getDaySessionPhase(insideWindow), "active");
  const status = decideFinalStatus({
    engine: "DAY",
    breakdown: computeDayTradeScore({
      newsCatalystScore: 100,
      economicSurpriseScore: 100,
      crossMarketConfirmationScore: 100,
      technicalScore: 100,
      marketRegimeScore: 100,
    }),
    crossAssetContradicted: false,
    now: insideWindow,
  });
  assert.equal(status, "TRADE");
});

console.log("\nopportunity ranking / correlation de-duplication");
test("a lower-ranked correlated instrument (ES vs NQ) is suppressed", () => {
  const base: Omit<TradeSignal, "id" | "instrument" | "confidence"> = {
    engine: "DAY",
    direction: "SHORT",
    catalyst: "test",
    newsSummary: "test",
    economicSurpriseScore: null,
    fundamentalScore: null,
    technicalScore: null,
    crossMarketConfirmationScore: null,
    marketRegimeScore: null,
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

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("\nSome tests FAILED.");
} else {
  console.log("All tests passed.");
}
