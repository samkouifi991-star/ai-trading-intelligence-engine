import { NextResponse } from "next/server";
import { getLatestPremarketContext } from "@/lib/pipeline/premarketContext";

export async function GET() {
  const result = getLatestPremarketContext(new Date());
  return NextResponse.json(result);
}
