/**
 * Populates the learning database with a few pipeline ticks so the
 * dashboards render meaningfully on first `npm run dev` — without this,
 * the DB is empty until the first real tick (or "Refresh now" click).
 * Safe to re-run; everything is upsert/insert-or-ignore.
 */
import { runFullPipeline } from "../src/lib/pipeline/orchestrator";

async function main() {
  console.log("Seeding trading-system learning database with sample pipeline ticks...\n");
  for (let i = 0; i < 3; i++) {
    const result = await runFullPipeline(new Date());
    console.log(
      `Tick ${i + 1}: news mode=${result.news.mode} headlinesSeen=${result.news.headlinesSeen} ` +
        `newStories=${result.news.newStories} | day candidates=${result.day.candidates.length} ` +
        `swing candidates=${result.swing.candidates.length}`
    );
    // Small delay so time-bucketed sample data (news/market) drifts between ticks.
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("\nSeed complete. Run `npm run dev` and open /day or /swing.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
