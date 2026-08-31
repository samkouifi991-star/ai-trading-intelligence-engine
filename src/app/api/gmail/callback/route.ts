import { NextResponse } from "next/server";
import { completeGmailOAuth } from "@/lib/gmail/client";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ ok: false, error: "missing ?code from Google" }, { status: 400 });
  }

  try {
    const { email } = await completeGmailOAuth(code);
    return NextResponse.redirect(new URL(`/status?gmail_connected=1&email=${encodeURIComponent(email ?? "")}`, url.origin));
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
