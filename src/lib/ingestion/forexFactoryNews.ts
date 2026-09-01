import { XMLParser } from "fast-xml-parser";
import type { RawHeadline } from "../types";
import type { NewsConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";
import { withConnectorHealth, resolveLiveOrFallback } from "./connectorHealth";
import { fetchForexFactoryNewsDirect } from "./forexFactoryNewsDirect";
import { fetchWithTimeout } from "./fetchWithTimeout";

const PRIMARY_KEY = "news:forexfactory";
const SECONDARY_KEY = "news:forexlive";

// ── Sample-mode fallback (used only when BOTH primary and secondary fail) ─

const SAMPLE_HEADLINE_TEMPLATES = [
  "Iran threatens retaliation after strikes near Strait of Hormuz",
  "Fed's {name} says rate cuts \"not imminent\" amid sticky inflation",
  "China cuts benchmark lending rate to support slowing growth",
  "OPEC+ signals possible extension of production cuts",
  "ECB's {name} flags growing concern over eurozone stagnation",
  "US Treasury yields spike after hot CPI print",
  "Israel-Hezbollah tensions escalate along northern border",
  "Bank of Japan hints at further policy normalization",
  "US initial jobless claims jump to highest level in 8 months",
  "Saudi Arabia raises official selling price for crude to Asia",
  "White House considers new tariffs on Chinese EV imports",
  "UK gilt yields fall as BOE opens door to faster cuts",
];

const NAMES = ["Powell", "Williams", "Waller", "Lagarde", "Schnabel", "Bailey"];

function templateToHeadline(template: string, rand: () => number): string {
  if (template.includes("{name}")) {
    return template.replace("{name}", NAMES[Math.floor(rand() * NAMES.length)]);
  }
  return template;
}

function timeBucketSeedAt(t: number): number {
  return hashString(`ffnews:${Math.floor(t / (18 * 60_000))}`);
}

function sampleHeadlines(sinceUtc?: string): RawHeadline[] {
  const since = sinceUtc ? new Date(sinceUtc).getTime() : Date.now() - 3 * 3600_000;
  const headlines: RawHeadline[] = [];
  const stepMs = 18 * 60_000;
  let t = Math.ceil(since / stepMs) * stepMs;
  const now = Date.now();
  for (; t <= now; t += stepMs) {
    const rand = mulberry32(timeBucketSeedAt(t));
    const idx = Math.floor(rand() * SAMPLE_HEADLINE_TEMPLATES.length);
    headlines.push({
      id: `sample-news-${t}`,
      timestampUtc: new Date(t).toISOString(),
      headline: templateToHeadline(SAMPLE_HEADLINE_TEMPLATES[idx], rand),
      source: "Sample breaking news (development mode — live feeds unreachable)",
      sourceQuality: 82,
      contentType: "verified_news",
    });
  }
  return headlines;
}

// ── PRIMARY: direct Forex Factory scrape (or a licensed FF feed override) ──

async function fetchPrimary(overrideUrl: string | undefined): Promise<RawHeadline[]> {
  return withConnectorHealth(PRIMARY_KEY, async () => {
    const items = overrideUrl ? await fetchJsonFeed(overrideUrl) : await fetchForexFactoryNewsDirect();
    return { data: items };
  });
}

async function fetchJsonFeed(url: string): Promise<RawHeadline[]> {
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json" }, cache: "no-store" }, 8000);
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  const rows = (await res.json()) as any[];
  return rows.map(
    (row): RawHeadline => ({
      id: row.id,
      timestampUtc: row.timestampUtc ?? row.publishedAt,
      headline: row.headline ?? row.title,
      body: row.body ?? row.summary,
      source: row.source ?? "Forex Factory News (configured feed)",
      sourceQuality: row.sourceQuality ?? 90,
      url: row.url,
      ffImpact: row.impact ?? row.ffImpact,
      relatedCurrency: row.currency ?? row.relatedCurrency ?? null,
      contentType: "verified_news",
    })
  );
}

// ── SECONDARY: ForexLive RSS — supplementary, never the primary source ────

/**
 * ForexLive's public RSS feed. Genuinely secondary: it supplements the
 * primary Forex Factory source (concurrent, not fallback-on-failure-only —
 * both are always attempted so a fast-moving story reported by either wire
 * reaches the pipeline), lower sourceQuality, and — critically — not
 * counted in the Day engine's required data-quality sources (see
 * dataQuality/dataQualityEngine.ts's dayRequiredSources), so its health
 * never gates a trade the way the primary source does.
 */
const FOREXLIVE_RSS_URL = "https://www.forexlive.com/feed/";

const xmlParser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object" && "__cdata" in (node as any)) return String((node as any).__cdata);
  if (typeof node === "object") return String((node as any)["#text"] ?? "");
  return String(node);
}

/** Parses one RSS <item> (already decoded from XML into a plain object by
 * fast-xml-parser) into our RawHeadline shape. Exported for unit testing
 * against a realistic hand-built RSS fixture — this cannot be exercised
 * against the real live feed from inside a network-restricted environment. */
export function mapRssItem(item: any, sourceLabel: string): RawHeadline | null {
  const title = textOf(item.title).trim();
  const pubDateRaw = textOf(item.pubDate) || textOf(item["dc:date"]);
  if (!title || !pubDateRaw) return null;
  const parsed = new Date(pubDateRaw);
  if (Number.isNaN(parsed.getTime())) return null;

  const description = stripHtml(textOf(item.description));
  const guid = textOf(item.guid) || textOf(item.link) || `${title}-${pubDateRaw}`;

  return {
    id: `news-${hashString(guid)}`,
    timestampUtc: parsed.toISOString(),
    headline: title,
    body: description || undefined,
    source: sourceLabel,
    sourceQuality: 78,
    url: textOf(item.link) || undefined,
    contentType: "verified_news",
  };
}

async function fetchSecondary(): Promise<RawHeadline[]> {
  return withConnectorHealth(SECONDARY_KEY, async () => {
    const res = await fetchWithTimeout(
      FOREXLIVE_RSS_URL,
      { headers: { accept: "application/rss+xml, application/xml, text/xml" }, cache: "no-store" },
      8000
    );
    if (!res.ok) throw new Error(`ForexLive RSS HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = xmlParser.parse(xml);
    const items = parsed?.rss?.channel?.item;
    if (!items) throw new Error("ForexLive RSS did not contain any <item> entries");
    const list = Array.isArray(items) ? items : [items];
    const headlines = list.map((item) => mapRssItem(item, "ForexLive (secondary)")).filter((h): h is RawHeadline => h !== null);
    if (headlines.length === 0) return { data: headlines, partial: "Feed reachable but returned zero parseable headlines" };
    return { data: headlines };
  });
}

// ── Combined connector ──────────────────────────────────────────────────

/**
 * Fetches PRIMARY (Forex Factory) and SECONDARY (ForexLive) concurrently
 * and merges — this is the "same story from multiple sources must cluster
 * into one story_id" hierarchy: both streams feed the same downstream
 * clustering (see news/clustering.ts), which dedupes by headline
 * similarity regardless of which wire reported it first. If BOTH fail,
 * resolveLiveOrFallback governs dev/production behavior (sample fallback
 * in dev; DataUnavailableError in production — see appMode.ts).
 */
class CombinedNewsConnector implements NewsConnector {
  constructor(private readonly overrideUrl: string | undefined) {}

  async fetchLatest(sinceUtc?: string): Promise<RawHeadline[]> {
    return resolveLiveOrFallback(
      PRIMARY_KEY,
      async () => {
        const [primaryResult, secondaryResult] = await Promise.allSettled([
          fetchPrimary(this.overrideUrl),
          fetchSecondary(),
        ]);

        const merged: RawHeadline[] = [];
        if (primaryResult.status === "fulfilled") merged.push(...primaryResult.value);
        if (secondaryResult.status === "fulfilled") merged.push(...secondaryResult.value);

        if (merged.length === 0) {
          // Both failed (or both returned nothing) — propagate the primary's
          // error so resolveLiveOrFallback's dev/production branch applies.
          throw primaryResult.status === "rejected" ? primaryResult.reason : new Error("No headlines from any news source");
        }

        return filterSince(merged, sinceUtc);
      },
      () => filterSince(sampleHeadlines(sinceUtc), sinceUtc)
    );
  }
}

function filterSince(headlines: RawHeadline[], sinceUtc?: string): RawHeadline[] {
  if (!sinceUtc) return headlines;
  const sinceMs = new Date(sinceUtc).getTime();
  return headlines.filter((h) => new Date(h.timestampUtc).getTime() > sinceMs);
}

export function getNewsConnector(): { connector: NewsConnector; mode: "live" } {
  return { connector: new CombinedNewsConnector(process.env.FOREX_FACTORY_NEWS_URL), mode: "live" };
}
