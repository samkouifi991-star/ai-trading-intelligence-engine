import { NextResponse } from "next/server";
import { getCurrentRegime } from "@/lib/pipeline/regimePipeline";

export async function GET() {
  try {
    const result = await getCurrentRegime();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
