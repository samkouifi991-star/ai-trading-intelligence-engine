import { NextResponse } from "next/server";
import { buildGmailAuthUrl, isGmailConfigured } from "@/lib/gmail/client";

/** Start here to connect the Gmail account that receives Forex Factory email
 * alerts. Redirects to Google's OAuth consent screen; on approval Google
 * redirects to /api/gmail/callback, which stores the refresh token. */
export async function GET() {
  if (!isGmailConfigured()) {
    return NextResponse.json(
      { error: "Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI (see .env.example)." },
      { status: 400 }
    );
  }
  return NextResponse.redirect(buildGmailAuthUrl());
}
