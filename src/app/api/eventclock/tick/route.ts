import { NextResponse } from "next/server";
import { captureEventClockTicks } from "@/lib/pipeline/eventClock";

/**
 * Dedicated, cheap, idempotent-per-checkpoint capture endpoint. Call this
 * directly (in addition to /api/cron/tick, which also calls it) from a
 * faster poller if you want closer-to-real T+15s/T+30s fidelity than a
 * typical serverless cron's 1-minute minimum — see eventClock.ts's doc
 * comment.
 */
export async function GET() {
  const result = await captureEventClockTicks(new Date());
  return NextResponse.json(result);
}

export const POST = GET;
