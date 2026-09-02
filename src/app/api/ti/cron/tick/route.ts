import { NextResponse } from "next/server";
import { runTiTick } from "@/lib/ti/pipeline/tick";

/** Orchestrator entrypoint for an external scheduler — same CRON_SECRET
 * pattern as /api/cron/tick (the Day/Swing engine's tick route). Point
 * Vercel Cron / cron-job.org here every few minutes. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await runTiTick();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
