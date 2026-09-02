import { NextResponse } from "next/server";
import { getAllSourceHealth } from "@/lib/ti/db/dataSources";
import { getAppMode } from "@/lib/config/appMode";
import { DatabaseUnconfiguredError } from "@/lib/ti/db/client";

// Never statically cache — this must reflect the real, current DB state on
// every request, not whatever it happened to be at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await getAllSourceHealth();
    return NextResponse.json({ appMode: getAppMode(), databaseConfigured: true, health });
  } catch (err) {
    if (err instanceof DatabaseUnconfiguredError) {
      return NextResponse.json({ appMode: getAppMode(), databaseConfigured: false, health: [], error: err.message });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
