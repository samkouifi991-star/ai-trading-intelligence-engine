import { NextResponse } from "next/server";
import { runTiTick } from "@/lib/ti/pipeline/tick";

/** Manual trigger for the /opportunities dashboard's "Refresh now" button —
 * runs the same tick as /api/ti/cron/tick, without requiring CRON_SECRET. */
export async function POST() {
  try {
    const result = await runTiTick();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET = POST;
