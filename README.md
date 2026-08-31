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

As of Phase 2, every ingestion connector **attempts real live data by
default — no API key required for calendar, news, or market data**:

| Source | Live implementation | Key required? |
|---|---|---|
| Economic calendar | `faireconomy.media`'s public JSON mirror of Forex Factory's own calendar data | No |
| Breaking news | ForexLive's public RSS (Forex Factory has no public news feed — see below) | No |
| Market prices (XAUUSD/ES/NQ/WTI/FX/DXY/VIX) | Yahoo Finance's public chart API | No |
| US 2Y / US 10Y yields | FRED (Federal Reserve Economic Data) public CSV export | No |
| Forex Factory email alerts | Gmail API (OAuth) | Yes — your own Google Cloud OAuth credentials |
| AI News Understanding | OpenAI | Yes — `OPENAI_API_KEY` |

If a live fetch fails for any reason (network egress blocked, the host is
down, the API changed shape), that connector **falls back to sample data**
so the pipeline keeps running end-to-end rather than crashing — but the
failure is never hidden. Every real fetch attempt — success or failure — is
recorded in the `connector_health` table and shown live on the **Live Data
Status** dashboard tab as `LIVE` / `PARTIAL` / `SAMPLE` / `BLOCKED`, each
with the actual error detail and timestamp. `SAMPLE` means "deliberately not
configured yet" (e.g. Gmail, or the LLM without a key); `BLOCKED` means "a
real attempt was made against the real host and it failed" — these are never
conflated.

**One honest substitution, stated plainly:** Forex Factory has no public
breaking-news API — its news wire only exists behind the logged-in website
UI, and scraping that HTML would be fragile and ToS-gray. The default live
breaking-news source is therefore ForexLive's public RSS feed instead — a
real, keyless, forex/macro-focused wire covering the same kind of catalysts.
It is never relabeled as "Forex Factory" anywhere (code, database, or UI all
say "ForexLive"). Set `FOREX_FACTORY_NEWS_URL` to a licensed FF feed if you
have one — the connector interface doesn't care where headlines come from.

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
`parseYahooChartResponse`, `parseFredCsv`, `mapRssItem`) is a single,
isolated place to fix it.

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
