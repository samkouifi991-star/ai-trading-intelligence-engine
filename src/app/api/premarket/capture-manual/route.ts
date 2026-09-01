import { NextResponse } from "next/server";
import { capturePremarketContext } from "@/lib/pipeline/premarketContext";

/** Manual trigger for the Day dashboard's "Capture pre-market now" button —
 * runs the same capture as /api/premarket/capture (the 09:45 ET scheduled
 * route), without requiring CRON_SECRET. Useful for testing outside the
 * 09:45 window, or to populate a fresh deployment immediately rather than
 * waiting for tomorrow's scheduled capture. */
export async function POST() {
  try {
    const context = await capturePremarketContext(new Date());
    return NextResponse.json(context);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
