import { NextResponse } from "next/server";
import { getLatestCurrencyStrengthAll } from "@/lib/ti/db/currencyStrength";
import { DatabaseUnconfiguredError } from "@/lib/ti/db/client";

export const dynamic = "force-dynamic";

/** One indexed DISTINCT ON query returning all 8 currencies' latest row —
 * never 8 separate requests, never a scan of the full history table. */
export async function GET() {
  try {
    const results = await getLatestCurrencyStrengthAll();
    return NextResponse.json({ currencies: results });
  } catch (err) {
    if (err instanceof DatabaseUnconfiguredError) {
      return NextResponse.json({ currencies: [], error: err.message }, { status: 200 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
