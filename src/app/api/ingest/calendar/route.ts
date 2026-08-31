import { NextResponse } from "next/server";
import { ingestEconomicCalendar } from "@/lib/pipeline/economicPipeline";

export async function GET() {
  try {
    const result = await ingestEconomicCalendar();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const POST = GET;
