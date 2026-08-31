import { NextResponse } from "next/server";
import { ingestAndAnalyzeNews } from "@/lib/pipeline/newsPipeline";

export async function GET() {
  try {
    const result = await ingestAndAnalyzeNews();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const POST = GET;
