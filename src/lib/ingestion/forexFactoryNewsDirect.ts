import * as cheerio from "cheerio";
import { hashString } from "./seededRandom";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { RawHeadline } from "../types";

export interface ForexFactoryNewsItem extends RawHeadline {
  url: string; // required here, unlike the optional base field
}

const NEWS_URL = "https://www.forexfactory.com/news";

/**
 * Direct scrape of forexfactory.com/news — this is the PRIMARY breaking-
 * news source per spec (Forex Factory itself, not a substitute). Forex
 * Factory has no public news API, so this is genuine HTML scraping, which
 * is inherently more fragile than the calendar's JSON export and CAN break
 * if FF changes its markup — that's an accepted tradeoff for analyzing FF
 * directly rather than only a secondary wire. A parse that finds zero items
 * is treated as a failure (never silently returned as "0 headlines,
 * everything's fine"), so a markup change shows up as `blocked` on the
 * Live Data Status page, not a quiet gap — see forexFactoryNews.ts, which
 * falls back to ForexLive (secondary) when this throws.
 */
export async function fetchForexFactoryNewsDirect(): Promise<ForexFactoryNewsItem[]> {
  const res = await fetchWithTimeout(
    NEWS_URL,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    },
    8000
  );
  if (!res.ok) {
    // 403/503 with a Cloudflare/anti-bot signature is the single most likely
    // real-world failure mode for a direct scrape of a site with bot
    // protection — call it out explicitly rather than a bare HTTP code, so
    // the Live Data Status page's detail column names the actual cause.
    const server = res.headers.get("server") ?? "";
    const antiBot =
      (res.status === 403 || res.status === 503) && /cloudflare/i.test(server)
        ? " — response headers indicate Cloudflare anti-bot protection rejected this request"
        : res.status === 403 || res.status === 429
          ? " — likely blocked by anti-bot/rate-limit protection"
          : "";
    throw new Error(`Forex Factory news page HTTP ${res.status}${antiBot}`);
  }
  const html = await res.text();
  const items = parseForexFactoryNewsHtml(html);
  if (items.length === 0) {
    throw new Error(
      "Forex Factory news page returned 0 parseable items — its markup likely changed; update the selectors in forexFactoryNewsDirect.ts"
    );
  }
  return items;
}

/**
 * Exported for unit testing against a realistic fixture. Real live HTML
 * cannot be fetched from inside this build's network-restricted
 * environment, and forexfactory.com's markup is not an officially
 * documented/versioned API, so this parser is verified against a hand-built
 * fixture approximating FF's news list structure — not a guarantee it
 * matches production byte-for-byte. If FF's real markup differs, the
 * zero-items check above turns that into a visible `blocked` status rather
 * than a wrong-but-silent result.
 *
 * Selector strategy is deliberately broad/defensive (several fallback
 * attribute/class patterns) rather than pinned to one exact class name,
 * since a scraper this specific breaks the moment a site's build tooling
 * changes a CSS class hash.
 */
export function parseForexFactoryNewsHtml(html: string): ForexFactoryNewsItem[] {
  const $ = cheerio.load(html);
  const items: ForexFactoryNewsItem[] = [];
  const seenIds = new Set<string>();

  const candidateRows = $(
    "[class*='flexposts__item'], [class*='news__item'], li[class*='story'], article[class*='news']"
  );

  candidateRows.each((_, el) => {
    const $el = $(el);
    const linkEl = $el.find("a[href*='/news/'], a[class*='title']").first();
    const title = linkEl.text().trim();
    const href = linkEl.attr("href");
    if (!title || !href) return;

    const url = href.startsWith("http") ? href : `https://www.forexfactory.com${href.startsWith("/") ? "" : "/"}${href}`;
    const id = `ffnews-${hashString(url)}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const timeEl = $el.find("time").first();
    const datetimeAttr = timeEl.attr("datetime");
    const timestampUtc = datetimeAttr && !Number.isNaN(new Date(datetimeAttr).getTime()) ? new Date(datetimeAttr).toISOString() : new Date().toISOString();

    const classAttr = ($el.attr("class") ?? "") + " " + ($el.find("[class*='impact']").attr("class") ?? "");
    const ffImpact: ForexFactoryNewsItem["ffImpact"] = /high/i.test(classAttr)
      ? "high"
      : /medium|med(?!ia)/i.test(classAttr)
        ? "medium"
        : /low/i.test(classAttr)
          ? "low"
          : "unknown";

    const currencyEl = $el.find("[class*='currency'], [class*='flag'], [title][class*='cur']").first();
    const currency = (currencyEl.attr("title") || currencyEl.text().trim() || "").trim() || null;

    const summary = $el.find("[class*='excerpt'], [class*='summary'], p").first().text().trim();

    items.push({
      id,
      timestampUtc,
      headline: title,
      source: "Forex Factory News",
      sourceQuality: 92,
      url,
      body: summary || undefined,
      ffImpact,
      relatedCurrency: currency,
      contentType: "verified_news",
    });
  });

  return items;
}
