# AI Trading Intelligence Engine

A day-trading engine and a swing-trading engine that share one real-time
macro/news intelligence layer but score independently, per the design brief.
This is its own standalone product — its own repository, its own Next.js
app, its own database, its own environment variables and deployment. It has
no dependency on, and shares no code, database, or deployment with, any
other project.

## Trading Intelligence Engine rebuild — Phase 1 (current)

This repo is being rebuilt into a broader "continuously rank the best
FX/gold trading opportunities right now" platform (economic surprise
scoring, currency strength, news intelligence, technical/cross-market
confirmation, trader consensus, a final trade-ranking engine, backtesting —
see the full spec's 30 sections). It's being built in the 6 phases the spec
itself lays out, one verified phase at a time, reusing this repo's existing
ingestion connectors and safety patterns (`APP_MODE`, connector-health
tracking, `DataUnavailableError`, sample-data labeling) rather than starting
over. **This is a different phase sequence from the "Phase 2/3" headers
below**, which describe the original two-engine (Day/Swing) product's own
build history — that product still exists, still works, and is now labeled
"(legacy)" in the nav while this rebuild supersedes it.

New code lives under `src/lib/ti/` and the `/opportunities` dashboard
(now the app's default landing page); the legacy Day/Swing engine is
untouched and still runs on its own SQLite file.

**What Phase 1 actually delivers:**

- **Database**: a new Postgres schema (`supabase/migrations/0001_trading_intelligence_schema.sql`),
  designed to live in the user's *existing* Supabase project inside its own
  `trading_intel` Postgres schema — never touching, reading, or writing any
  other application's tables in that project (isolation is at the schema
  level, not just table-name prefixing). All 26 tables the full spec needs
  are created now (economic events/surprises, news, narratives, currency
  strength, market prices/candles, technical/cross-market/reaction scores,
  trader intelligence, market regimes, trade candidates/recommendations/
  outcomes, system weights, data-source health, AI analysis logs) so later
  phases never need a schema-churning migration — but only the Phase-1-
  relevant tables are populated today; the rest sit empty and ready.
- **Market data**: reuses the legacy engine's `MarketDataProvider`
  abstraction (Yahoo/Twelve Data) unchanged; extended the symbol mapping
  and universe to the spec's 10 starting markets (EURUSD, GBPUSD, USDJPY,
  USDCHF, AUDUSD, NZDUSD, USDCAD, EURJPY, GBPJPY, XAUUSD — architected so
  indices/silver/oil/crypto slot in later via the same `TI_UNIVERSE` table,
  see `src/lib/ti/universe.ts`).
- **Forex Factory Calendar ingestion**: reuses the legacy engine's real,
  live, keyless FairEconomy JSON connector as-is; wraps it in the new
  system's own Postgres-backed connector-health tracking
  (`src/lib/ti/db/dataSources.ts`) rather than the legacy SQLite one.
- **Economic Surprise Engine v2**: still never scores `actual - forecast`
  directly — every surprise is a z-score against that indicator's own
  accumulating historical distribution (built from real ingested releases,
  bootstrapped from a documented catalog prior only when there isn't yet
  enough history), blended with the revision-to-previous surprise, resolved
  to hawkish/dovish via the indicator's known polarity, scaled by Forex
  Factory's impact level, and normalized to the spec's single -100..+100
  per-currency scale. Every computed score is persisted with its full
  component breakdown (`trading_intel.economic_surprises`) for audit.
- **Currency Strength Engine**: real -100..100 scores for all 8 currencies,
  built from whatever components are genuinely wired this tick — recent
  economic surprises, live price action across every pair touching that
  currency, a VIX-driven safe-haven/risk-currency read, and (USD only) a
  real FRED 2Y/10Y yield-change component. **News and central-bank
  components are structurally present in the schema/type but explicitly
  return `not_available_yet` and are excluded from the weighted average**
  — never silently blended in as a fake neutral 0 (which would just dilute
  every score toward zero). Every component that touches a legacy-engine
  data source (VIX, FRED) double-checks that source's *actual* last-fetch
  status before trusting it, so a legacy-side sample-mode fallback can
  never silently feed a "real" score in the new system.
- **Basic dashboard** (`/opportunities`): currency strength bars with a
  per-component breakdown, a real-time data-source status table, and a
  recent/upcoming economic releases feed with surprise scores — all with
  the same dev-mode banner and "Sample Data" badging as the legacy
  dashboards, and a clear "database not configured" state instead of a
  crash when `DATABASE_URL` is unset.
- **Egress-consciousness, built in from the start** (per explicit
  instruction, since the target Supabase project has already exceeded its
  Free-plan egress quota): every read route uses selective columns and
  bounded windows/limits, never `SELECT *` over a growing table; the 8
  currencies' latest strength read as one indexed `DISTINCT ON` query, not
  8 round trips; "current" values also write through a tiny single-row-per-
  key cache table (`trading_intel.latest_values`) rather than requiring a
  history-table scan on every read; the economic-surprise scoring job
  cools down 6h per event so an unchanged release isn't re-scored (and
  rewritten) on every 5-minute tick; no Realtime subscriptions, no
  client-side polling of anything but small cached values.

**What's genuinely live vs. mocked right now:** identical to the legacy
engine's honesty rules — every source's `connector_health`-equivalent row
reflects its actual last attempt, sample-mode fallback is only ever used in
`APP_MODE=development` and is labeled everywhere it can reach the UI
(`SampleDataBadge`, `isSampleSource` on both signals and calendar events).
In *this* sandboxed dev environment, live network egress is blocked (same
restriction documented throughout this README already), so every source
shows `blocked`/sample here — that is the correct, honest behavior, not a
bug; a real deployment with real internet access should show `live` for
the calendar and market-data sources. Verified locally end-to-end against
a real local Postgres 16 instance (schema applies cleanly and
idempotently; ingestion, scoring, and the dashboard all round-trip
correctly) — see the credentials checklist below for what's required to
point this at the real Supabase project.

**What's explicitly blocked / not attempted, and why:**

- **Trader intelligence (spec sections 6-7)**: Forex Factory has no public
  API for individual trader performance or Trade Explorer data, and
  scraping personal trader accounts is far more legally/technically fragile
  than the news/calendar scraping already built. The full schema exists
  (`traders`, `trader_performance`, `trader_expertise`, `trader_positions`,
  `trader_consensus`) but nothing populates it — per the user's own
  decision, this stays `DATA UNAVAILABLE` until a real, legitimate source
  is identified.
- **Non-USD sovereign yields**: FRED gives free daily USD 2Y/10Y yields
  (already wired); EUR/GBP/JPY/CHF/CAD/AUD/NZD equivalents are real,
  separate data sources this build does not have wired yet — their yield
  component reads `not_available_yet` rather than a fabricated proxy.
- **News/central-bank currency-strength components**: Phase 2 (news
  classification + narrative memory) hasn't been built yet — these read
  `not_available_yet` by design, not a bug.
- **Redis**: deferred per explicit choice; `trading_intel.latest_values` is
  the real cache backing store today (see `src/lib/ti/cache/cache.ts`),
  behind the same `getCached`/`setCached` interface a real Redis client
  would need, so swapping it in later touches no caller.

**Environment variables this phase needs:** `DATABASE_URL` (your Supabase
project's Postgres connection string — see the credentials checklist
below) is the only new one; everything else (`MARKET_DATA_PROVIDER`,
`TWELVE_DATA_API_KEY`, `FOREX_FACTORY_CALENDAR_URL`, `CRON_SECRET`,
`APP_MODE`) is shared with the legacy engine and already documented there.

**Assumptions made (stated plainly, all adjustable):** the component
weights (economic 40% / price action 30% / risk 20% / yield 10%,
renormalized over whatever's actually available) and the three scale
constants (`PRICE_ACTION_SCALE`, `VIX_RISK_SCALE`, `YIELD_SCALE` in
`src/lib/ti/scoring/currencyStrength.ts`) are documented starting points,
not calibrated/backtested values — Phase 6's backtesting is exactly what
should eventually replace them with data-driven weights (spec section 22's
`system_weights` table already exists for this). USD/JPY/CHF are treated
as safe havens and AUD/NZD/CAD as risk-linked per standard FX convention;
EUR/GBP are deliberately left unclassified rather than guessed.

**Real-Supabase verification**: the sandboxed environment this code was
written in cannot reach Supabase at all — every host under
`supabase.com`/`*.supabase.co` is rejected by that session's own egress
policy (confirmed directly: 403/502 policy denials from the proxy itself,
logged in `recentRelayFailures`; the same restriction that blocks Yahoo
Finance/FRED/Forex Factory/Vercel throughout this README). No
`DATABASE_URL`, however valid, changes that — the block is at the network
layer, before credentials are ever checked. So the actual Supabase
connection has to be verified from somewhere with real internet access —
your Vercel deployment. `GET /api/ti/verify` (protected by `CRON_SECRET`
if set, same bearer-token pattern as `/api/ti/cron/tick`) runs entirely
server-side there and returns one structured report: live schema/index/
constraint introspection straight from Postgres's own catalogs (never
assumed from the migration file), before/after row counts across one real
tick, current data-source health, one real (never sample-sourced —
explicitly `null` if none exists yet, never fabricated) scored release,
current currency strength, and an approximate app-measured read/write byte
count for that one call (a proxy for Postgres traffic — not Supabase's own
network-level egress metering, which this app has no API to read). Verified
locally against a real local Postgres 16 instance before ever being pointed
at Supabase — see the Phase 1 verification report for actual output.

## The core design principle, and how the code enforces it

**The LLM explains news. It never decides whether to trade.** Every score,
every decay curve, every threshold, and the final TRADE/WATCH/NO_TRADE status
is computed by plain deterministic TypeScript in `src/lib/scoring` and
`src/lib/signals/validation.ts`. The one and only LLM call in the system
(`src/lib/news/aiUnderstanding.ts`) returns a structured explanation of a
news story (causal chain, per-asset directional impact, inflation/growth/
rate/risk reads) — it is never asked for, and never allowed to set, a
confidence score or a trade decision. `scripts/run-tests.ts` has explicit
tests proving a high composite score is still forced to `NO_TRADE` when
cross-asset confirmation is contradicted, and forced to `WATCH` (never
`TRADE`) outside the day engine's 10:00–13:00 ET issue window — see
"deterministic validation gate" in that file.

## Quick start

```bash
cd trading-system
npm install
cp .env.example .env.local   # optional — see "Live vs sample data" below
npm run seed                 # populates the learning DB with a few sample ticks
npm test                     # runs the deterministic-engine test suite
npm run dev                  # http://localhost:3000 -> redirects to /day
```

Click **Refresh now** on either dashboard tab to run a full pipeline tick
on demand (calendar + news ingestion, then both engines re-score).

## Live vs. sample data

Every ingestion connector **attempts real live data by default — no API key
required for the Forex Factory Calendar, Forex Factory News, or market
data**:

| Source | Live implementation | Key required? |
|---|---|---|
| Economic calendar | Forex Factory's own Weekly Export JSON (`nfs.faireconomy.media`) | No |
| Breaking news (PRIMARY) | Direct scrape of forexfactory.com/news | No |
| Breaking news (SECONDARY) | ForexLive's public RSS, fetched concurrently | No |
| Market prices (XAUUSD/ES/NQ/WTI/FX/DXY/VIX) | Yahoo Finance's public chart API (or Twelve Data, if configured) | No (Yahoo) / Yes (Twelve Data) |
| 2Y/10Y rate pressure (Day-engine, intraday) | ZT/ZN Treasury futures via the same market-data provider | No (Yahoo) |
| 2Y/10Y yields (Swing-engine/dashboard, daily) | FRED (Federal Reserve Economic Data) public CSV export | No |
| Forex Factory email alerts | Gmail API (OAuth) | Yes — your own Google Cloud OAuth credentials |
| AI News Understanding | OpenAI | Yes — `OPENAI_API_KEY` |

**In `APP_MODE=development`** (the default), a failed live fetch falls back
to sample data so the pipeline keeps running end-to-end for testing.
**In `APP_MODE=production`**, a failed live fetch throws
`DataUnavailableError` instead — sample data can never contribute to a
production trade (see "Phase 3" below). Either way, every real fetch
attempt — success or failure — is recorded in `connector_health` and shown
live on the **Live Data Status** tab (`/status`) as a
SOURCE/STATUS/LATENCY/AGE/ROLE table. `SAMPLE` means "deliberately not
configured" (e.g. Gmail, or the LLM without a key); `BLOCKED` means "a real
attempt was made against the real host and it failed"; `UNKNOWN` means "no
attempt recorded yet this session" — these are never conflated.

**One honest substitution, stated plainly:** Forex Factory has no public
API for its news wire — the PRIMARY source (`forexFactoryNewsDirect.ts`)
scrapes forexfactory.com/news directly, which is genuine HTML scraping and
can break if FF's markup changes (a zero-item parse is treated as a
failure, never silent success). ForexLive's public RSS is the SECONDARY
source, always labeled "ForexLive (secondary)", never relabeled as Forex
Factory, and not counted in the Day engine's required data-quality sources.

See `src/lib/ingestion/README.md` for the full connector-by-connector
breakdown and how to point each one at a different provider.

## Phase 2 verification: a real end-to-end tick

This development sandbox's outbound network policy blocks the actual data
hosts above (faireconomy.media, Yahoo Finance, FRED, ForexLive — confirmed
via explicit `403` policy denials, not transient errors), so a live fetch
cannot be proven *from inside this sandbox*. What was verified here instead:

1. **Every real parser is unit-tested against a fixture matching that API's
   real, documented/observed response schema** (`npm test` —
   `parseYahooChartResponse`, `parseFredCsv`, `mapFairEconomyRow`,
   `mapRssItem`, `parseFeedNumber`) — 24/24 passing.
2. **A real end-to-end tick was run** (`POST /api/analyze` against a live
   `npm run dev` server) and produced this actual chain, in order:
   - Calendar + news + Gmail-poll ingestion attempted live against the real
     hosts → all four market/news hosts returned `403` (this sandbox's
     policy) → `connector_health` correctly recorded `blocked` for each,
     with the real HTTP status in the detail field → each connector fell
     back to sample data so the pipeline continued.
   - News clustering/decay ran on the (fallback) headlines and produced
     real story records.
   - The economic-surprise engine, cross-asset confirmation engine, and
     both Day and Swing composite scorers ran on that data and produced
     real `NO_TRADE`/`WATCH` decisions (e.g. `XAUUSD LONG, confidence 36,
     NO_TRADE` — correctly below the 70-point threshold) — proving the
     deterministic gate, not the LLM, is what decided nothing was
     actionable.
   - The learning database recorded 11 events across 4 instruments.
   - `POST /api/premarket/capture` and `POST /api/learning/track-reactions`
     both ran successfully against that same state.
3. **`GET /api/status`** was inspected directly and showed the honest
   picture: every market/news/calendar source `blocked` with its real error,
   Gmail/LLM `sample` (not configured), nothing silently claiming `live`.

This proves the wiring, the fallback behavior, and the decision chain are
correct. It does **not** prove the live hosts return exactly the shape this
build expects — that can only be confirmed by running a tick somewhere with
real internet egress (deploy to Vercel, or run `npm run dev` on your own
machine) and checking `/status`. If any parser needs adjusting once you do,
each one's fixture-tested function (`mapFairEconomyRow`,
`parseYahooChartResponse`, `parseFredCsv`, `mapRssItem`,
`parseForexFactoryNewsHtml`) is a single, isolated place to fix it.

## Phase 3: production safety, real Forex Factory sourcing, data quality gating

Corrections made after Phase 2 review, before this can be trusted for real
10:00–13:00 ET trading:

1. **`APP_MODE=development|production`** (`src/lib/config/appMode.ts`).
   Sample-data fallback only ever happens in development. In production, a
   blocked required source throws `DataUnavailableError` instead — verified
   live in this same network-restricted sandbox: with `APP_MODE=production`,
   `POST /api/analyze` returned every instrument's `noTradeReasons` as
   `"required cross-market confirmation data unavailable"` with the real
   blocking error, zero fabricated candidates, HTTP 200 (graceful, not a
   crash — see below). Compare to the same tick in development mode, which
   fell back to sample data and still produced (correctly low-confidence,
   correctly `NO_TRADE`) candidates for testing.
   - One real bug this surfaced and fixed: the first version let a single
     blocked source (the calendar) throw uncaught out of the orchestrator's
     `Promise.all`, 500-ing the *entire* tick. Fixed so each ingestion step
     is isolated (`orchestrator.ts`'s `safeIngest`) — one blocked source
     degrades gracefully; the day/swing engines still run and produce
     per-instrument reasons.
2. **Data Quality Engine** (`src/lib/dataQuality/dataQualityEngine.ts`),
   wired into the single validation gate (`signals/validation.ts`): every
   signal carries a weighted 0–100 quality score from its actual required
   sources' `connector_health`. `>=90` normal, `75-89` confidence penalty,
   `60-74` WATCH-only regardless of composite score, `<60` NO_TRADE
   regardless of composite score — verified live: a perfect-100 composite
   scored against 45/100 quality in this sandbox produced `NO_TRADE`, and a
   real tick produced `XAUUSD LONG, composite→confidence 28 (quality 31)` →
   `NO_TRADE`, exactly the rule from the spec ("a 92 shouldn't trade on 45
   quality").
3. **Real intraday Treasury rate-pressure** replaces FRED for the Day
   engine's confirmation. FRED (`DGS2`/`DGS10`) is daily-resolution and
   cannot show a 10:00:00 → 10:00:30 → 10:01 reaction; it's now kept as
   `us2yDaily`/`us10yDaily` (Swing-engine/dashboard context only — never fed
   into Day-engine confirmation). Real-time proxy: **ZT/ZN Treasury
   futures**, fetched intraday like any other instrument, normalized via
   `src/lib/marketdata/ratePressure.ts`'s documented scale into a signed
   `us2yRatePressure`/`us10yRatePressure` (-100..100, "+72 hawkish" style)
   so nothing downstream has to interpret raw futures prices.
4. **MarketDataProvider abstraction** (`src/lib/marketdata/`) — `getQuote`/
   `getCandles`/`subscribe`/`getLatencyMs`/`getHealth`, implemented by
   `YahooProvider` (default, keyless, honestly labeled `realtime: false`),
   `TwelveDataProvider` (real paid REST+WebSocket, gated behind
   `TWELVE_DATA_API_KEY`), and a `CmeProvider` that is a **documented,
   deliberately non-functional stub** — it requires a licensed CME Market
   Data Platform agreement this build doesn't have, and throws rather than
   pretending. `marketData.ts` adapts whichever provider is configured to
   the same interface the scoring engines already used — switching
   providers touches zero engine code. `connector_health` now also records
   latency, realtime/streaming mode, and market-open/closed per source.
5. **Direct Forex Factory news** (`forexFactoryNewsDirect.ts`) is now the
   PRIMARY breaking-news source (`news:forexfactory`), scraping
   forexfactory.com/news directly — genuine HTML scraping, so more fragile
   than the calendar's JSON export; a parse finding zero items is treated as
   a failure, never silently "nothing happened". ForexLive is demoted to
   SECONDARY (`news:forexlive`) — fetched concurrently, not gating, always
   labeled "ForexLive (secondary)". Both streams feed the same clustering,
   so the same story from both sources becomes one `story_id`. The calendar
   is now labeled **Forex Factory Calendar** everywhere (it's FF's own
   Weekly Export mechanism, not a third-party mirror).
6. **Event Clock** (`src/lib/pipeline/eventClock.ts`) captures per-story
   multi-market snapshots at T0/T+15s/T+30s/T+1m/T+2m/T+5m/T+15m/T+30m/T+60m
   and produces a reconciliation report — verified by two unit tests proving
   a same-sign actual move confirms a prediction and an opposite-sign move
   does not. Honest scope notes, both in that file's doc comment:
   - **T-5m/T-1m are not implemented.** They're only meaningful for a
     *scheduled* catalyst with a known time (a calendar release) — a
     breaking-news story's first-seen moment IS its t0; there's no "before"
     to snapshot. Linking a story to its triggering calendar row to support
     pre-event capture is a documented extension, not built here.
   - **T+15s/T+30s fidelity depends on tick cadence.** Vercel Cron's
     minimum granularity is 1 minute; on that cadence these checkpoints are
     captured at the next tick after they're due, with the real elapsed
     time recorded — never mislabeled as on-time. `GET /api/eventclock/tick`
     is a cheap, idempotent-per-checkpoint endpoint you can hit from a
     faster external poller for true sub-minute fidelity.
7. **Prediction vs. confirmation, never blended.** `TradeSignal` now carries
   `newsImpactScore` (signed, from the news-understanding engine) and
   `marketConfirmationScore` (signed, computed independently from actual
   momentum + DXY reaction — `crossAsset/confirmationEngine.ts`'s
   `computeConfirmationDirectionScore`) as separate fields, shown as
   separate values in the dashboard, next to the reconciled `direction`.
8. **Source attribution + confirmed fields** added to the AI news
   understanding output (`sourceAttribution`, `confirmed`) — who said it,
   and whether this reads as confirmed fact vs. unconfirmed/rumored.
   **Community sentiment guardrail**: `RawHeadline.contentType` is a fixed
   `"verified_news"` literal, and a deliberately unused
   `CommunitySentimentSignal` type (`contentType: "community_sentiment"`)
   documents that FF comments/forum content, if ever ingested, is
   structurally incompatible with the news pipeline and can't be passed into
   `analyzeStory`/scoring by accident — nothing currently populates it.
9. **Live Data Status redesigned** as a SOURCE / STATUS / LATENCY / AGE /
   ROLE table (`/status`) instead of a flat badge grid — ROLE (PRIMARY /
   SECONDARY / PRIMARY TRIGGER / PRIMARY PRICE / CONFIRMATION / MACRO ONLY /
   ANALYSIS) makes it impossible to mistake "connected" for "suitable for
   day trading."

**Item 12 (final live validation) is explicitly not done and cannot be done
from here**: this authoring sandbox's network policy blocks every real data
host (confirmed via the proxy's own policy-denial log, not a transient
error), so no environment reachable from this session can complete a fully
real end-to-end event. What *was* verified from here — parser correctness
against realistic fixtures, the full decision chain end-to-end in both dev
and production mode, the data-quality gate, the event-clock reconciliation
logic — is listed above with actual results, not claimed. The one remaining
step is yours: deploy this (Vercel, or `npm run dev` on a machine with real
internet), hit `/status` to confirm every PRIMARY/CONFIRMATION source reads
`live`, then run one real tick during 10:00–13:00 ET and report back what
`/day` shows — that is the genuine proof this system needs before being
trusted with real trading decisions.

## Architecture

```
src/lib/
  types.ts                 shared domain types (the contract every module speaks)
  universe.ts               tradable universe + correlation metadata
  time/session.ts            America/New_York day-trading window (10:00-13:00 ET) gate

  ingestion/                 pluggable connectors: FF calendar, FF news, FF email
                              parser, market data (prices + DXY/2Y/10Y/VIX)

  economicSurprise/          historical surprise distributions -> z-scores,
                              revision blending (75/25), regime-aware
                              hawkish/dovish interpretation (never "actual >
                              forecast = bullish")

  news/
    clustering.ts             groups near-duplicate headlines into one story
    decay.ts                   fast (day) / slow (swing) decay curves,
                                reset only by genuinely new developments
    aiUnderstanding.ts          the one LLM call: story -> structured JSON

  regime/regimeEngine.ts      deterministic macro regime (growth/inflation/
                              risk/rate-bias) from DXY/2Y/10Y/VIX

  crossAsset/confirmationEngine.ts
                              compares the predicted reaction against what
                              DXY/yields/VWAP/momentum are actually doing;
                              a contradiction forces NO_TRADE downstream

  technical/indicators.ts     VWAP, support/resistance, momentum,
                              volatility percentile, volume

  scoring/
    dayTradeScore.ts           35/20/20/15/10 weighted composite + bands
    swingScore.ts               25/20/15/10/20/10 weighted composite + bands
    rank.ts                     ranks + suppresses correlated duplicates

  signals/
    validation.ts               THE deterministic TRADE/WATCH/NO_TRADE gate
    signalBuilder.ts             assembles the full spec'd signal-output object

  gmail/client.ts              Gmail OAuth2 client (connect/callback/refresh)

  pipeline/                   orchestration: ingest -> analyze -> score -> persist
                              includes gmailPipeline.ts (poll + feed alerts into
                              the news pipeline), reactionTracking.ts (fills in
                              the learning DB's follow-up prices/MFE/MAE),
                              premarketContext.ts (09:45 ET capture)
  db/                         SQLite "learning database" (schema.sql +
                              repository.ts) — every analyzed event is stored
                              whether or not it became a trade

src/app/
  day/page.tsx, swing/page.tsx, status/page.tsx   the three dashboard tabs
  api/                          ingest/{calendar,news,email}, analyze,
                                 cron/tick, signals/{day,swing}, regime,
                                 status, news/stories, economic/upcoming,
                                 gmail/{connect,callback,poll},
                                 premarket/{capture,latest},
                                 learning/track-reactions
```

## Scheduling

Next.js has no always-on background process on most hosts. `GET
/api/cron/tick` (protected by `CRON_SECRET` if set) is the orchestrator
entrypoint — point an external scheduler (Vercel Cron, cron-job.org, a
simple `curl` in a cron job) at it every few minutes. It runs continuously
through the day, not just 10:00–13:00 ET, so the "begin collecting before
10:00 so a complete regime is ready" requirement is satisfied by ticking
early and often — the 10:00–13:00 ET restriction on *issuing new day-trade
ideas* is enforced inside `signals/validation.ts`, independent of when this
route happens to be called. `runFullPipeline` (called by `/api/cron/tick`)
already includes calendar, news, Gmail polling, both engines, and reaction
tracking in one call — you only need a second scheduled hit for `GET
/api/premarket/capture` around 09:45 ET daily.

`vercel.json` at the repo root already contains this cron config:

```json
{
  "crons": [
    { "path": "/api/cron/tick", "schedule": "*/5 * * * *" },
    { "path": "/api/premarket/capture", "schedule": "45 13 * * 1-5" }
  ]
}
```

(09:45 ET is 13:45 UTC during EDT / 14:45 UTC during EST — adjust for
daylight saving, or just tick frequently enough that a same-morning capture
always lands close to 09:45 regardless.) Vercel Cron sends no auth header by
default, so either leave `CRON_SECRET` unset or configure Vercel's
[cron secret verification](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).

**Vercel's Hobby plan restricts Cron Jobs to a daily schedule** (and a low
job count) — `*/5 * * * *` above needs a Pro plan or higher to actually fire
every 5 minutes; on Hobby, Vercel silently coerces it down to once a day,
which is nowhere near often enough for an intraday day-trading engine. If
you're on Hobby, either upgrade the Vercel project, or point a
plan-independent external scheduler like
[cron-job.org](https://cron-job.org) (free, real per-minute intervals) at
`GET https://<your-deployment>/api/cron/tick` with an `Authorization: Bearer
$CRON_SECRET` header instead — `vercel.json`'s cron config and an external
scheduler can both be active at once with no conflict, since the route
itself is idempotent per call. Either way, verify it's actually firing: the Day/Swing dashboards' Market/
Macro Regime card shows "last tick <time>" (from `tickAtUtc`), which should
be a few minutes old, not hours.

## Deploying to Vercel

This is a standard Next.js app, so `vercel` (CLI) or importing the repo at
vercel.com/new deploys it with zero build configuration. One thing to set up
first, because it doesn't work "for free" the way the rest does:

**The learning database needs a real network DB in production.** Locally,
`src/lib/db/db.ts` uses `better-sqlite3` against a file under `./data/` —
that's fine on a normal server, but Vercel's serverless functions have a
read-only filesystem (aside from `/tmp`, which is wiped between invocations),
so a SQLite file does not persist there. Before deploying:

1. Provision a serverless-friendly database — the least-friction option is
   [Turso](https://turso.tech) (hosted libSQL, same SQL dialect as SQLite,
   so `schema.sql` needs no changes), or Vercel Postgres/Neon/Supabase if you
   prefer Postgres.
2. Reimplement `getDb()`/the query calls in `src/lib/db/db.ts` and
   `src/lib/db/repository.ts` against that provider's client. Every caller
   goes through `repository.ts`'s exported functions, so this is the only
   file that needs to change — no call site elsewhere in the app knows or
   cares which database is behind it.
3. Add the resulting connection string/token to your Vercel project's
   environment variables (see below) in place of `TRADING_DB_PATH`.

Then set environment variables on the Vercel project (Settings →
Environment Variables) from `.env.example` — at minimum `OPENAI_API_KEY` (or
leave unset to run on the heuristic news-analysis fallback) and `CRON_SECRET`
(generate a random string; required so `/api/cron/tick` isn't publicly
callable). Add a Vercel Cron entry (`vercel.json` → `crons`) hitting
`/api/cron/tick` with that bearer token every few minutes so ingestion keeps
running without anyone having the dashboard open.

## Credentials setup checklist

Every variable below is documented in full in `.env.example`; this is just
the same list re-sorted by "do I actually need this right now," since not
everything gates a genuinely-live deployment the same way.

**REQUIRED NOW** — without these, the deployment cannot be a real
production instance, regardless of how many data sources are live:

- `CRON_SECRET` — a random string. Without it, `/api/cron/tick`,
  `/api/premarket/capture`, and `/api/ti/cron/tick` are publicly callable by
  anyone with the URL.
- **For the legacy Day/Swing engine**: a real network database + a
  `src/lib/db/db.ts`/`repository.ts` reimplementation against it (see
  "Deploying to Vercel" above) — the default `TRADING_DB_PATH=/tmp/trading.db`
  is wiped on every cold start and is verification-only, never production
  storage.
- **For the new Trading Intelligence Engine** (`/opportunities`,
  `src/lib/ti/*`): `DATABASE_URL` — your Supabase project's Postgres
  connection string (the "Transaction" pooler URI, port 6543, for
  serverless compatibility). Already implemented against real Postgres, in
  its own `trading_intel` schema — no reimplementation needed, just run
  `supabase/migrations/0001_trading_intelligence_schema.sql` against your
  project once and set this variable.
- `APP_MODE=production` — set only once the above are done. This is the
  single switch that turns off sample-data fallback entirely (spec rule 5);
  leaving it at `development` in a "production" deployment is the one
  configuration mistake that defeats every other safety mechanism in this
  app.

**OPTIONAL** — the app is genuinely live and safe without these; each one
upgrades one specific source from a working-but-limited default to
something better:

- `OPENAI_API_KEY` (+ `OPENAI_MODEL`, default `gpt-4o-mini`) — without it,
  AI News Understanding runs on a deterministic keyword heuristic instead of
  the LLM. This is a real, working fallback (not sample data), and the
  dashboards label it honestly as `heuristic-fallback`, never as `live`.
- `TWELVE_DATA_API_KEY` + `MARKET_DATA_PROVIDER=twelvedata` — without these,
  market data runs on Yahoo Finance's public chart API by default: real live
  prices, keyless, but an unofficial endpoint with no SLA (see `getHealth()`
  in `src/lib/marketdata/providers/yahoo.ts` — it reports `realtime: false`
  honestly rather than overclaiming). Setting both switches the primary
  provider to Twelve Data's paid low-latency REST feed (Yahoo remains the
  automatic fallback either way — see `src/lib/marketdata/registry.ts`).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` (Gmail
  Forex Factory alert ingestion) — a supplementary trigger source; direct
  Forex Factory News scraping and the Forex Factory Calendar are already the
  primary path and work without this.
- `FOREX_FACTORY_CALENDAR_URL` / `FOREX_FACTORY_NEWS_URL` — only needed to
  override the default keyless public sources with a licensed feed (e.g. a
  paid Forex Factory Flex Account export).
- `INBOUND_EMAIL_WEBHOOK_SECRET` — only needed if you use the inbound-email-
  webhook alerting path instead of the Gmail OAuth path above.
- `MARKET_DATA_API_KEY` / `MARKET_DATA_BASE_URL` — only needed to wire a
  different premium REST vendor (a broker API, Polygon, etc.) instead of
  Yahoo/Twelve Data.

**NOT YET NEEDED** — nothing in this codebase currently reads these; there
is no code path they would unlock today:

- Any broker/execution API key. There is no order-execution engine in this
  app by design (spec rule: the system issues signals, it never places
  trades) — nothing to configure.
- A CME direct-feed credential. `src/lib/marketdata/providers/cme.ts` is a
  documented non-functional stub, not wired to any real endpoint.
- A positioning/flows (CFTC COT-style) data source credential — not wired
  up yet; the swing score's positioning/flows input is held at a fixed
  neutral 50/100 placeholder rather than fabricated (see `swingEngine.ts`).

## Known limitations (stated plainly)

- **Positioning/flows** (the swing score's 10% slice) has no wired data
  source (a real implementation would use CFTC COT data) — it's held at a
  neutral 50/100 placeholder rather than fabricated, and the Swing dashboard
  says so explicitly.
- **Support/resistance** detection is a straightforward local-pivot scan
  over recent bars, not a full market-structure engine.
- Sample-mode market data (used only as a fallback when a live fetch fails)
  is a seeded random walk anchored to plausible current price levels — good
  enough to keep the pipeline running end-to-end, not a real quote feed.
- **US 2Y/US 10Y yields are daily-resolution**, not intraday — FRED settles
  Treasury yields once per business day. `marketData:US2Y`/`US10Y` will show
  `partial` if the latest observation is more than ~4 days old (e.g. a long
  weekend), which is expected, not a bug.
- **Gmail alert ingestion is polling, not push.** Each cron tick polls Gmail
  for new alert emails since the last successful poll — "immediate" in
  practice means "within one tick interval," not a true push webhook. A
  Gmail `watch()` + Pub/Sub integration would close that gap; it's a
  documented upgrade, not implemented here to avoid requiring a separate GCP
  Pub/Sub topic just for this.
- **Yahoo Finance and FRED are unofficial-but-widely-used free endpoints**,
  not contractually guaranteed APIs — they can change shape or rate-limit
  without notice. If that happens, `connector_health` will show `blocked`
  with the real error rather than silently serving stale/wrong data, and the
  fix is isolated to the relevant parser function (see "Phase 2
  verification" above).
- This build could not exercise a real live fetch against any of these hosts
  from its authoring environment — its network policy blocks them (see
  "Phase 2 verification" above). Confirm real connectivity by checking
  `/status` after your first deploy or local `npm run dev` with real internet
  access.
