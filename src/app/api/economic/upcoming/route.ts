import { NextResponse } from "next/server";
import { getEventsInRange } from "@/lib/db/repository";

export async function GET() {
  const now = new Date();
  const events = getEventsInRange(now.toISOString(), new Date(now.getTime() + 72 * 3600_000).toISOString());
  return NextResponse.json({ events });
}
