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

Every ingestion connector (`src/lib/ingestion/*`) is written against a real
interface and ships a deterministic **sample-mode** provider so the entire
pipeline — clustering, decay, the economic-surprise engine, both scoring
engines, both dashboards — is fully exercisable with zero credentials. Each
dashboard's header shows a `live`/`sample` pill per connector so it's never
ambiguous which mode produced a given signal. See
`src/lib/ingestion/README.md` for exactly what env vars flip each connector
to live mode (Forex Factory has no public API, so "live" calendar/news means
pointing at a licensed feed or your own scraper service that emits the same
JSON shape — documented there).

Without `OPENAI_API_KEY` set, the AI News Understanding Engine
(`src/lib/news/aiUnderstanding.ts`) falls back to a small keyword-based
heuristic (clearly labeled, confidence capped at 40) instead of failing, so
`npm run dev` works out of the box.

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

  pipeline/                   orchestration: ingest -> analyze -> score -> persist
  db/                         SQLite "learning database" (schema.sql +
                              repository.ts) — every analyzed event is stored
                              whether or not it became a trade

src/app/
  day/page.tsx, swing/page.tsx   the two dashboard tabs
  api/                          ingest/{calendar,news,email}, analyze,
                                 cron/tick, signals/{day,swing}, regime,
                                 status, news/stories, economic/upcoming
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
route happens to be called.

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
- Sample-mode market data is a seeded random walk anchored to plausible
  current price levels — good enough to exercise every downstream engine
  end-to-end, not a real quote feed.
- The **learning database**'s follow-up price columns (`price_after_5m`,
  MFE/MAE, etc.) are schema-complete and written to by
  `db/repository.ts`, but nothing currently schedules the follow-up price
  polling job that would fill them in over time — wire a scheduled job
  calling `recordFollowUpPrice`/`updateExcursions` against
  `getOpenLearningRecords()` to activate the "which news types produce
  reliable moves" learning loop described in the spec.
