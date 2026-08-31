import { NextResponse } from "next/server";
import { emailToHeadline } from "@/lib/ingestion/types";
import { getRecentStories } from "@/lib/db/repository";
import { processHeadline } from "@/lib/pipeline/newsPipeline";

/**
 * Inbound-parse webhook target for Forex Factory email alerts. Point your
 * email provider's inbound-parse webhook (Mailgun, SendGrid, Postmark, ...)
 * here. An incoming email is turned into a headline and pushed straight
 * through the same clustering + AI news-understanding pipeline breaking news
 * uses, so it "immediately triggers the news-analysis pipeline" per spec —
 * there is no separate queue or delay.
 *
 * Expected JSON body: { subject, bodyText, messageId, receivedUtc? }
 * (adjust the field mapping below if your provider's webhook payload shape
 * differs — Mailgun/SendGrid/Postmark all use slightly different keys).
 */
export async function POST(request: Request) {
  const secret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.subject || !body?.bodyText) {
    return NextResponse.json({ error: "expected { subject, bodyText, messageId }" }, { status: 400 });
  }

  const headline = emailToHeadline({
    subject: body.subject,
    bodyText: body.bodyText,
    receivedUtc: body.receivedUtc ?? new Date().toISOString(),
    messageId: body.messageId ?? String(Date.now()),
  });

  const workingSet = getRecentStories(50);
  const novelty = await processHeadline(headline, workingSet);

  return NextResponse.json({ ok: true, storyNovelty: novelty, headline });
}
