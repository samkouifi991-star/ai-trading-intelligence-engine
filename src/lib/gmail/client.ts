import { google } from "googleapis";
import { getOAuthTokens, saveOAuthTokens } from "../db/repository";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function isGmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

export function isGmailConnected(): boolean {
  return getOAuthTokens("gmail") !== null;
}

function newOAuth2Client() {
  if (!isGmailConfigured()) {
    throw new Error("Gmail is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function buildGmailAuthUrl(): string {
  const client = newOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token on every connect, not just the first
    scope: SCOPES,
  });
}

export async function completeGmailOAuth(code: string): Promise<{ email: string | null }> {
  const client = newOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token — if this account was connected before, revoke access at https://myaccount.google.com/permissions and try again (Google only issues a refresh_token on first consent unless prompt=consent, which is already set)."
    );
  }

  client.setCredentials(tokens);
  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ auth: client, version: "v2" });
    const info = await oauth2.userinfo.get();
    email = info.data.email ?? null;
  } catch {
    email = null;
  }

  saveOAuthTokens({
    provider: "gmail",
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? null,
    accessTokenExpiresUtc: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    connectedEmail: email,
    lastHistoryId: null,
  });

  return { email };
}

/** Returns an authenticated Gmail API client using the stored refresh token,
 * refreshing the access token as needed. Throws if Gmail was never
 * connected — callers should check isGmailConnected() first. */
export async function getGmailClient() {
  const stored = getOAuthTokens("gmail");
  if (!stored) throw new Error("Gmail is not connected — visit /api/gmail/connect first");

  const client = newOAuth2Client();
  client.setCredentials({ refresh_token: stored.refreshToken });

  return google.gmail({ version: "v1", auth: client });
}
