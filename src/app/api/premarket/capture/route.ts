import { NextResponse } from "next/server";
import { capturePremarketContext } from "@/lib/pipeline/premarketContext";

/** Point an external scheduler at this route around 09:45 America/New_York
 * every trading day (protected by CRON_SECRET if set, same as /api/cron/tick). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const context = await capturePremarketContext(new Date());
  return NextResponse.json(context);
}

export const POST = GET;
