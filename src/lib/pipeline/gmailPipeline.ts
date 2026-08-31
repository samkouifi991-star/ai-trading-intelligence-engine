import { getGmailClient, isGmailConfigured, isGmailConnected } from "../gmail/client";
import { emailToHeadline } from "../ingestion/types";
import { getRecentStories } from "../db/repository";
import { processHeadline } from "./newsPipeline";
import { recordConnectorHealth, getAllConnectorHealth } from "../ingestion/connectorHealth";

const SOURCE_KEY = "gmail";
const DEFAULT_QUERY = "from:forexfactory.com";

export interface GmailPollResult {
  connected: boolean;
  configured: boolean;
  messagesSeen: number;
  processed: number;
}

/**
 * Polls Gmail for Forex Factory alert emails and feeds each one straight
 * through the same clustering + AI news-understanding pipeline breaking
 * news uses (via processHeadline), so a Forex Factory email alert reaches
 * the analysis pipeline on the next tick — see app/api/cron/tick. A true
 * push-based (Gmail watch() + Pub/Sub) integration would be more strictly
 * "immediate" than polling; that's a documented upgrade path, not
 * implemented here to avoid requiring a separate GCP Pub/Sub topic just to
 * demonstrate the ingestion path.
 */
export async function pollGmailForexFactoryAlerts(): Promise<GmailPollResult> {
  const configured = isGmailConfigured();
  const connected = isGmailConnected();
  if (!configured || !connected) {
    recordConnectorHealth(
      SOURCE_KEY,
      "sample",
      !configured ? "GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI not set" : "Gmail not connected — visit /api/gmail/connect"
    );
    return { connected, configured, messagesSeen: 0, processed: 0 };
  }

  try {
    const gmail = await getGmailClient();
    const since = lastSuccessfulPollUnix();
    const query = `${process.env.GMAIL_FF_QUERY || DEFAULT_QUERY} after:${since}`;

    const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 25 });
    const messages = list.data.messages ?? [];

    const workingSet = getRecentStories(50);
    let processed = 0;

    for (const m of messages) {
      if (!m.id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
      const headers = full.data.payload?.headers ?? [];
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
      const bodyText = extractPlainText(full.data.payload) || full.data.snippet || "";
      const receivedUtc = full.data.internalDate
        ? new Date(Number(full.data.internalDate)).toISOString()
        : new Date().toISOString();

      const headline = emailToHeadline({ subject, bodyText, receivedUtc, messageId: m.id });
      await processHeadline(headline, workingSet);
      processed++;
    }

    recordConnectorHealth(SOURCE_KEY, "live", `Polled ${messages.length} message(s), processed ${processed}`);
    return { connected, configured, messagesSeen: messages.length, processed };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordConnectorHealth(SOURCE_KEY, "blocked", detail);
    return { connected, configured, messagesSeen: 0, processed: 0 };
  }
}

function lastSuccessfulPollUnix(): number {
  const health = getAllConnectorHealth().find((h) => h.sourceKey === SOURCE_KEY);
  if (health?.lastSuccessUtc) {
    return Math.floor(new Date(health.lastSuccessUtc).getTime() / 1000);
  }
  return Math.floor((Date.now() - 2 * 86_400_000) / 1000); // first run: look back 2 days
}

/** Gmail message bodies arrive as a MIME tree; walks it for the first
 * text/plain part (falling back to a stripped text/html part) and decodes
 * from base64url. */
function extractPlainText(payload: any): string | null {
  if (!payload) return null;

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html" && p.body?.data);
    if (htmlPart) return decodeBase64Url(htmlPart.body.data).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  return null;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}
