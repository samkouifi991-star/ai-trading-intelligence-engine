import { NextResponse } from "next/server";
import { runFullPipeline } from "@/lib/pipeline/orchestrator";

/** Manual trigger for the dashboard's "Refresh now" button — runs the same
 * full pipeline as /api/cron/tick, without requiring CRON_SECRET. */
export async function POST() {
  try {
    const result = await runFullPipeline(new Date());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET = POST;
