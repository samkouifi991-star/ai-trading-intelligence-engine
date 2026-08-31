# AI Trading Intelligence Engine

A day-trading engine and a swing-trading engine that share one real-time
macro/news intelligence layer but score independently, per the design brief.
This is its own standalone product — its own repository, its own Next.js
app, its own database, its own environment variables and deployment. It has
no dependency on, and shares no code, database, or deployment with, any
other project.

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

Example `vercel.json` cron config:

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
