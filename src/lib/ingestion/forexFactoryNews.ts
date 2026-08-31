import { XMLParser } from "fast-xml-parser";
import type { RawHeadline } from "../types";
import type { NewsConnector } from "./types";
import { hashString, mulberry32 } from "./seededRandom";
import { withConnectorHealth } from "./connectorHealth";

const SOURCE_KEY = "news";

// ── Sample-mode fallback (used only when the live feed can't be reached) ──

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

class SampleNewsConnector implements NewsConnector {
  async fetchLatest(sinceUtc?: string): Promise<RawHeadline[]> {
    const since = sinceUtc ? new Date(sinceUtc).getTime() : Date.now() - 3 * 3600_000;
    const headlines: RawHeadline[] = [];
    const stepMs = 18 * 60_000;
    let t = Math.ceil(since / stepMs) * stepMs;
    const now = Date.now();
    for (; t <= now; t += stepMs) {
      const seed = timeBucketSeedAt(t);
      const rand = mulberry32(seed);
      const idx = Math.floor(rand() * SAMPLE_HEADLINE_TEMPLATES.length);
      const headline = templateToHeadline(SAMPLE_HEADLINE_TEMPLATES[idx], rand);
      headlines.push({
        id: `sample-news-${t}`,
        timestampUtc: new Date(t).toISOString(),
        headline,
        source: "Sample breaking news (live feed unreachable)",
        sourceQuality: 82,
      });
    }
    return headlines;
  }
}

// ── Live connector ──────────────────────────────────────────────────────

/**
 * Forex Factory has no public breaking-news API or RSS feed — its news wire
 * is only exposed through the logged-in website UI. Rather than scrape HTML
 * (fragile, ToS-gray, and liable to break silently), the default live
 * source here is ForexLive's public RSS feed: a real, keyless, forex/macro-
 * focused breaking-news wire covering the same kind of catalysts (central
 * banks, geopolitics, data surprises). It is intentionally NOT relabeled as
 * "Forex Factory" anywhere — the UI and connector health both say
 * "ForexLive" so this substitution is never hidden. Set
 * FOREX_FACTORY_NEWS_URL to point at a licensed Forex Factory feed (or any
 * other JSON headline API — see mapJsonRow below) if you have one.
 */
const DEFAULT_NEWS_RSS_URL = "https://www.forexlive.com/feed/";

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
  };
}

async function fetchRssHeadlines(url: string, sourceLabel: string): Promise<RawHeadline[]> {
  const res = await fetch(url, { headers: { accept: "application/rss+xml, application/xml, text/xml" }, cache: "no-store" });
  if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);
  const items = parsed?.rss?.channel?.item;
  if (!items) throw new Error("RSS feed did not contain any <item> entries");
  const list = Array.isArray(items) ? items : [items];
  return list
    .map((item) => mapRssItem(item, sourceLabel))
    .filter((h): h is RawHeadline => h !== null);
}

function mapJsonRow(row: any): RawHeadline {
  return {
    id: row.id,
    timestampUtc: row.timestampUtc ?? row.publishedAt,
    headline: row.headline ?? row.title,
    body: row.body ?? row.summary,
    source: row.source ?? "forex-factory-live",
    sourceQuality: row.sourceQuality ?? 80,
    url: row.url,
  };
}

class LiveNewsConnector implements NewsConnector {
  constructor(private readonly url: string, private readonly sourceLabel: string, private readonly format: "rss" | "json") {}

  async fetchLatest(sinceUtc?: string): Promise<RawHeadline[]> {
    const all = await withConnectorHealth(SOURCE_KEY, async () => {
      const headlines =
        this.format === "rss" ? await fetchRssHeadlines(this.url, this.sourceLabel) : await this.fetchJson();
      if (headlines.length === 0) {
        return { data: headlines, partial: "Feed reachable but returned zero parseable headlines" };
      }
      return { data: headlines };
    });
    if (!sinceUtc) return all;
    const sinceMs = new Date(sinceUtc).getTime();
    return all.filter((h) => new Date(h.timestampUtc).getTime() > sinceMs);
  }

  private async fetchJson(): Promise<RawHeadline[]> {
    const url = new URL(this.url);
    const res = await fetch(url.toString(), { headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`News feed HTTP ${res.status}`);
    const rows = (await res.json()) as any[];
    return rows.map(mapJsonRow);
  }
}

/** Always attempts the real live news wire first; only falls back to sample
 * headlines if the fetch genuinely fails. See connectorHealth for how the
 * Live Data Status page distinguishes "live", "blocked" (fetch attempted and
 * failed), and "sample" (deliberately not configured — not applicable here
 * since a live default is always attempted). */
class SmartNewsConnector implements NewsConnector {
  private live: LiveNewsConnector;
  private sample = new SampleNewsConnector();

  constructor(url: string, sourceLabel: string, format: "rss" | "json") {
    this.live = new LiveNewsConnector(url, sourceLabel, format);
  }

  async fetchLatest(sinceUtc?: string): Promise<RawHeadline[]> {
    try {
      return await this.live.fetchLatest(sinceUtc);
    } catch {
      return this.sample.fetchLatest(sinceUtc);
    }
  }
}

export function getNewsConnector(): { connector: NewsConnector; mode: "live" } {
  const overrideUrl = process.env.FOREX_FACTORY_NEWS_URL;
  if (overrideUrl) {
    return { connector: new SmartNewsConnector(overrideUrl, "Configured news feed (FOREX_FACTORY_NEWS_URL)", "json"), mode: "live" };
  }
  return { connector: new SmartNewsConnector(DEFAULT_NEWS_RSS_URL, "ForexLive (real-time forex news wire)", "rss"), mode: "live" };
}
