import { NextResponse } from "next/server";
import { getEventsWithSurpriseInRange } from "@/lib/ti/db/economicEvents";
import { DatabaseUnconfiguredError } from "@/lib/ti/db/client";

export const dynamic = "force-dynamic";

/** Bounded window (48h back, 72h ahead) in one query — never an unbounded
 * calendar scan. */
export async function GET() {
  try {
    const now = new Date();
    const events = await getEventsWithSurpriseInRange(
      new Date(now.getTime() - 48 * 3600_000).toISOString(),
      new Date(now.getTime() + 72 * 3600_000).toISOString()
    );
    return NextResponse.json({ events });
  } catch (err) {
    if (err instanceof DatabaseUnconfiguredError) {
      return NextResponse.json({ events: [], error: err.message }, { status: 200 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
