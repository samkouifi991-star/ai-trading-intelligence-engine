/**
 * A plain `fetch()` with no timeout can hang for the full length of a
 * serverless function's execution budget when an upstream host stalls
 * (as opposed to rejecting outright with a 4xx/5xx or a fast connection
 * error) — which is exactly what turns into an indefinite "Loading…" on the
 * dashboard instead of a diagnosable failure. This wraps fetch with an
 * AbortController-based deadline and throws a distinct, greppable
 * "Timeout after Xms" error so a stalled upstream is visibly different from
 * an HTTP-status failure or a DNS/connection error on the Live Data Status
 * page's detail column.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timeout after ${timeoutMs}ms fetching ${url}`);
    }
    // Node/undici surfaces DNS failures, TLS errors, and connection resets
    // as a generic "fetch failed" with the real cause in `.cause` — surface
    // that cause in the message so it shows up in connector_health.detail
    // instead of a useless "fetch failed".
    const cause = err instanceof Error && "cause" in err ? (err as any).cause : undefined;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : null;
    const base = err instanceof Error ? err.message : String(err);
    throw new Error(causeMsg ? `${base}: ${causeMsg} (fetching ${url})` : `${base} (fetching ${url})`);
  } finally {
    clearTimeout(timer);
  }
}
