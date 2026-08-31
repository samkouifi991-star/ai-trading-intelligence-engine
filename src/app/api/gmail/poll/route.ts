import { NextResponse } from "next/server";
import { pollGmailForexFactoryAlerts } from "@/lib/pipeline/gmailPipeline";

export async function GET() {
  const result = await pollGmailForexFactoryAlerts();
  return NextResponse.json(result);
}

export const POST = GET;
