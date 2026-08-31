# Ingestion connectors

Every connector attempts real live data by default — no API key required for
the Forex Factory Calendar, Forex Factory News, or market data (Yahoo
Finance / FRED). A connector only serves sample data as a fallback when a
live fetch genuinely fails, and only in `APP_MODE=development` — in
production a failure raises `DataUnavailableError` instead (see
`../config/appMode.ts`). Every real attempt, live or failed, is recorded in
the `connector_health` table and shown on the **Live Data Status** dashboard
tab, so "connected" is never confused with "actually live right now."

## Calendar — `forexFactoryCalendar.ts`

**This is the Forex Factory Calendar.** `ff_calendar_thisweek.json` is Forex
Factory's own Weekly Export mechanism (JSON/CSV/XML/ICS), served from
`nfs.faireconomy.media` — not a third-party mirror or approximation. Set
`FOREX_FACTORY_CALENDAR_URL` to point at a different export (e.g. a licensed
Flex Account feed) instead.

## Breaking news — `forexFactoryNews.ts` + `forexFactoryNewsDirect.ts`

**PRIMARY: Forex Factory News.** Forex Factory has no public news API, so
`forexFactoryNewsDirect.ts` scrapes `forexfactory.com/news` directly —
genuine HTML scraping, which is inherently more fragile than the calendar's
JSON export (FF's markup isn't a documented/versioned contract, and can
change). A parse that finds zero items is treated as a failure, never
silently returned as "nothing happened" — see that file's doc comments for
the selector strategy and its documented limits.

**SECONDARY: ForexLive.** A real, keyless, forex/macro-focused RSS wire,
fetched *concurrently* with the primary source (not just as a failure
fallback) so a story either wire reports first still reaches the pipeline
quickly. Always labeled "ForexLive (secondary)" — never relabeled as Forex
Factory. It is intentionally **not** counted in the Day engine's required
data-quality sources (`dataQuality/dataQualityEngine.ts`), so its health
never gates a trade the way the primary source's does.

Both streams feed the same `news/clustering.ts` — the same story reported by
both Forex Factory and ForexLive clusters into one `story_id`, not two.

Set `FOREX_FACTORY_NEWS_URL` to a licensed Forex Factory feed (JSON) to
replace the scraper with something more durable, while keeping ForexLive as
secondary.

## Email alerts — `../gmail/client.ts` + `/api/ingest/email`

Two paths, either or both can be active:

1. **Gmail OAuth** (primary path) — connect the Gmail account that receives
   Forex Factory's "email me when..." alerts; every cron tick polls for new
   ones and feeds them straight into the news pipeline. See
   `../pipeline/gmailPipeline.ts`.
2. **Inbound-parse webhook** — point your email provider's inbound-parse
   webhook (Mailgun, SendGrid, Postmark) at `POST /api/ingest/email` with
   `INBOUND_EMAIL_WEBHOOK_SECRET`. Calls `emailToHeadline()` (`types.ts`) and
   feeds the pipeline immediately on receipt — no polling delay.

## Market data — `../marketdata/*` + `marketData.ts`

Provider-agnostic by design (spec requirement: swap providers without
rewriting the scoring engines). `marketData.ts` is a thin adapter over
`../marketdata/registry.ts`'s provider selection:

- **Yahoo Finance** (`providers/yahoo.ts`) — default, keyless, but an
  unofficial/undocumented public endpoint (not a contracted real-time feed;
  `getHealth()` reports `realtime: false` honestly).
- **Twelve Data** (`providers/twelvedata.ts`) — real paid low-latency REST +
  WebSocket integration, set `MARKET_DATA_PROVIDER=twelvedata` +
  `TWELVE_DATA_API_KEY`. Streaming only works from a persistent process, not
  a serverless API route — see that file's doc comment and
  `scripts/streaming-worker.ts`.
- **CME** (`providers/cme.ts`) — documented, deliberately non-functional stub
  (requires a licensed CME Market Data Platform agreement this build doesn't
  have). Exists to complete the interface, not as working code.

Treasury 2Y/10Y: the Day engine's intraday cross-market confirmation uses
**ZT/ZN Treasury futures** (via whichever provider is active) normalized into
a signed hawkish/dovish "rate pressure" score (`../marketdata/ratePressure.ts`)
— never FRED, which is daily-resolution and cannot support intraday
confirmation. FRED (`fetchFredSeries` in `marketData.ts`) is kept as
daily-only macro context for the Swing engine and dashboard display.
