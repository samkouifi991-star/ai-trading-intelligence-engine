import { NextResponse } from "next/server";
import { getSql, DatabaseUnconfiguredError } from "@/lib/ti/db/client";
import { EXPECTED_TABLES, getTableInventory, getIndexInventory, getConstraintInventory, getExactRowCounts } from "@/lib/ti/db/introspect";
import { getAllSourceHealth } from "@/lib/ti/db/dataSources";
import { getLatestCurrencyStrengthAll } from "@/lib/ti/db/currencyStrength";
import { getExampleRealScoredRelease } from "@/lib/ti/db/economicEvents";
import { runTiTick } from "@/lib/ti/pipeline/tick";

export const dynamic = "force-dynamic";

/**
 * One-shot, end-to-end verification report against the REAL configured
 * Postgres/Supabase connection — built specifically because the sandboxed
 * session that wrote this code cannot itself reach Supabase (every host
 * under supabase.com/supabase.co is rejected by this session's egress
 * policy; confirmed directly, not assumed). This route runs inside
 * wherever DATABASE_URL actually points — a real Vercel deployment with
 * real internet access — so it can produce a genuinely verified report
 * instead of a simulated one.
 *
 * Never fabricates: every section either reports real, freshly-queried
 * data or explicitly says what's missing/blocked. The "egress" numbers are
 * an approximate, app-measured proxy (byte length of the JSON this route
 * itself read/wrote to Postgres during this one call) — not Supabase's own
 * network-level metering, which this app has no API access to. Labeled as
 * such in the response, not oversold as exact.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let readBytes = 0;
  let writeBytes = 0;
  const track = <T>(value: T, direction: "read" | "write"): T => {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    if (direction === "read") readBytes += bytes;
    else writeBytes += bytes;
    return value;
  };

  try {
    const sql = getSql();
    // Prove the connection is real, not just that getSql() didn't throw.
    const ping = await sql`SELECT now() AS db_time, current_database() AS db_name`;
    track(ping, "read");

    // 1. Schema/index/constraint verification, straight from Postgres's own
    // catalogs — not an assumption that the migration file "should" have worked.
    const [tables, indexes, constraints] = await Promise.all([
      getTableInventory(),
      getIndexInventory(),
      getConstraintInventory(),
    ]);
    track(tables, "read");
    track(indexes, "read");
    track(constraints, "read");
    const actualTableNames = new Set(tables.map((t) => t.tableName));
    const missingTables = EXPECTED_TABLES.filter((t) => !actualTableNames.has(t));

    // 2. Before counts (the handful of tables Phase 1 actually ingests into).
    const before = track(await getExactRowCounts(), "read");

    // 3. One real tick — the actual ingestion/scoring pipeline, unmodified.
    const tick = await runTiTick();
    writeBytes += Buffer.byteLength(JSON.stringify(tick), "utf8"); // approximates what this tick wrote

    // 4. After counts + deltas.
    const after = track(await getExactRowCounts(), "read");
    const delta = Object.fromEntries(
      Object.keys(before).map((k) => [k, (after as any)[k] - (before as any)[k]])
    );

    // 5. Data source health — which sources' last attempt was genuinely live.
    const health = track(await getAllSourceHealth(), "read");

    // 6. One real example scored release — never fabricated; null if none exists.
    const exampleRelease = track(await getExampleRealScoredRelease(), "read");

    // 7. Current currency strength for all 8 currencies, full component breakdown.
    const currencyStrength = track(await getLatestCurrencyStrengthAll(), "read");

    return NextResponse.json({
      connection: { connected: true, dbName: ping[0].dbName, dbTimeUtc: ping[0].dbTime },
      schema: {
        expectedTableCount: EXPECTED_TABLES.length,
        actualTableCount: tables.length,
        missingTables,
        tables,
        indexCount: indexes.length,
        constraintCount: constraints.length,
        constraintsByType: constraints.reduce((acc: Record<string, number>, c) => {
          acc[c.constraintType] = (acc[c.constraintType] ?? 0) + 1;
          return acc;
        }, {}),
      },
      tick,
      rowCounts: { before, after, delta },
      dataSourceHealth: health,
      exampleRealScoredRelease: exampleRelease,
      currencyStrength,
      approximateVolume: {
        note:
          "App-measured JSON payload size for this single verification call (schema introspection + one full tick + before/after counts + health + example + currency strength) — a proxy for Postgres traffic, not Supabase's own network-level egress metering, which this app has no API to read.",
        readBytes,
        writeBytes,
        totalBytes: readBytes + writeBytes,
      },
      generatedAtUtc: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof DatabaseUnconfiguredError) {
      return NextResponse.json({ connection: { connected: false, error: err.message } }, { status: 200 });
    }
    return NextResponse.json({ connection: { connected: false, error: String(err) } }, { status: 500 });
  }
}
