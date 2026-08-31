# Ingestion connectors

Every connector in this folder implements an interface from `types.ts`. Each
file ships a **sample/dev provider** that returns realistic, deterministically
seeded data — so the surprise engine, scoring, and dashboards are fully
exercisable with `npm run dev` and no credentials at all.

Forex Factory has no public REST API, so wiring a real feed means one of:

1. A licensed/structured calendar mirror (several vendors resell FF's
   calendar data in JSON/CSV) — point `FOREX_FACTORY_CALENDAR_URL` at it and
   implement `parseCalendarPayload()` in `forexFactoryCalendar.ts` for its
   schema.
2. Your own scraper/automation service that normalizes forexfactory.com into
   the `EconomicEvent` shape and exposes it over HTTP — same env var.
3. For breaking news: forexfactory.com's own news stream/RSS-like feed, via
   `FOREX_FACTORY_NEWS_URL`.
4. For email alerts: point Forex Factory's "email me when..." alerts at an
   inbox whose provider supports inbound-parse webhooks (Mailgun, SendGrid,
   Postmark). Configure that webhook to POST to `/api/ingest/email` with
   `INBOUND_EMAIL_WEBHOOK_SECRET` as a bearer/shared-secret header. That route
   calls `emailToHeadline()` (see `types.ts`) and feeds the result straight
   into the same news-analysis pipeline breaking news uses — so an email
   alert triggers analysis immediately, per spec.

Market data (`marketData.ts`) is provider-agnostic by design — set
`MARKET_DATA_BASE_URL`/`MARKET_DATA_API_KEY` to any OHLCV/quote REST API
(a broker's API, Polygon, Twelve Data, etc.) and implement `fetchLive()`.

None of this ships "faked as real" — every connector logs which mode
(`live` vs `sample`) it is running in, and that mode is surfaced in the
dashboard's system status so it's never ambiguous whether a signal was
generated from live inputs or demo fixtures.
