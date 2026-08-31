import type { RawHeadline } from "../types";
import type { NewsConnector } from "./types";
import { hashString, mulberry32, timeBucketSeed } from "./seededRandom";

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

class SampleNewsConnector implements NewsConnector {
  async fetchLatest(sinceUtc?: string): Promise<RawHeadline[]> {
    const since = sinceUtc ? new Date(sinceUtc).getTime() : Date.now() - 3 * 3600_000;
    const headlines: RawHeadline[] = [];
    // Emit one sample headline roughly every ~18 minutes since `since`.
    const stepMs = 18 * 60_000;
    let t = Math.ceil(since / stepMs) * stepMs;
    const now = Date.now();
    for (; t <= now; t += stepMs) {
      const seed = timeBucketSeedAt(t);
      const rand = mulberry32(seed);
      const idx = Math.floor(rand() * SAMPLE_HEADLINE_TEMPLATES.length);
      const headline = templateToHeadline(SAMPLE_HEADLINE_TEMPLATES[idx], rand);
      headlines.push({
        id: `ff-news-${t}`,
        timestampUtc: new Date(t).toISOString(),
        headline,
        source: "Forex Factory Breaking News (sample)",
        sourceQuality: 82,
      });
    }
    return headlines;
  }
}

function timeBucketSeedAt(t: number): number {
  return hashString(`ffnews:${Math.floor(t / (18 * 60_000))}`);
}

class LiveNewsConnector implements NewsConnector {
  constructor(private readonly baseUrl: string) {}

  async fetchLatest(sinceUtc?: string): Promise<RawHeadline[]> {
    const url = new URL(this.baseUrl);
    if (sinceUtc) url.searchParams.set("since", sinceUtc);
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`News feed error ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as any[];
    return rows.map((row) => ({
      id: row.id,
      timestampUtc: row.timestampUtc ?? row.publishedAt,
      headline: row.headline ?? row.title,
      body: row.body ?? row.summary,
      source: row.source ?? "forex-factory-live",
      sourceQuality: row.sourceQuality ?? 80,
      url: row.url,
    }));
  }
}

export function getNewsConnector(): { connector: NewsConnector; mode: "live" | "sample" } {
  const url = process.env.FOREX_FACTORY_NEWS_URL;
  if (url) return { connector: new LiveNewsConnector(url), mode: "live" };
  return { connector: new SampleNewsConnector(), mode: "sample" };
}
