/**
 * Example persistent process demonstrating TwelveDataProvider.subscribe() —
 * a real WebSocket subscription, which only makes sense from a long-lived
 * process. Next.js API routes (this app's serverless surface) can't hold a
 * WebSocket open between requests, so the main app polls getQuote() instead
 * (see src/lib/ingestion/marketData.ts). Run this separately (e.g. as a
 * small worker on Railway/Fly.io/a VPS) if you want true push-streaming
 * quotes for a subset of instruments.
 *
 * This script only logs incoming quotes — it does not write them anywhere
 * the main app reads from. Wiring that up (e.g. a live_quote_cache table
 * the serverless routes could read for fresher-than-polling prices) is a
 * documented extension, not implemented here, to keep this example focused
 * on the one thing worth demonstrating: the subscribe() call actually works
 * against Twelve Data's real endpoint.
 *
 * Usage: TWELVE_DATA_API_KEY=... npx tsx scripts/streaming-worker.ts XAUUSD ES
 */
import { TwelveDataProvider } from "../src/lib/marketdata/providers/twelvedata";
import { providerSymbol } from "../src/lib/marketdata/instruments";

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.error("Set TWELVE_DATA_API_KEY to run this worker.");
    process.exit(1);
  }

  const instruments = process.argv.slice(2);
  if (instruments.length === 0) {
    console.error("Usage: npx tsx scripts/streaming-worker.ts <INSTRUMENT> [INSTRUMENT...]  e.g. XAUUSD ES");
    process.exit(1);
  }

  const provider = new TwelveDataProvider(apiKey);
  const unsubscribers: (() => void)[] = [];

  for (const instrument of instruments) {
    const sym = providerSymbol(instrument, "twelvedata");
    const unsubscribe = provider.subscribe?.(sym, (quote) => {
      console.log(`[${quote.timestampUtc}] ${instrument} (${sym}) = ${quote.price}`);
    });
    if (unsubscribe) unsubscribers.push(unsubscribe);
    else console.warn(`${instrument}: subscribe() unavailable in this runtime`);
  }

  console.log(`Streaming ${instruments.join(", ")}. Ctrl+C to stop.`);
  process.on("SIGINT", () => {
    unsubscribers.forEach((u) => u());
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
