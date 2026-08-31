import { NextResponse } from "next/server";
import { runFullPipeline } from "@/lib/pipeline/orchestrator";

/**
 * Orchestrator entrypoint for an external scheduler. Point Vercel Cron (or
 * cron-job.org / any HTTP-capable scheduler) at this route every few minutes
 * with an `Authorization: Bearer $CRON_SECRET` header. Runs continuously
 * through the day (not just 10:00-13:00 ET) so the pre-10:00 prep phase and
 * the swing engine both stay warm — the 10:00-13:00 ET restriction is
 * enforced deterministically inside signals/validation.ts, not by when this
 * route is called.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await runFullPipeline(new Date());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
