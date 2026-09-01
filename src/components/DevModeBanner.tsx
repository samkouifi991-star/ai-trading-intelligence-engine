/**
 * Shown on every dashboard whenever the deployment is not APP_MODE=production
 * — i.e. whenever a failed live fetch is still allowed to fall back to
 * sample data (see src/lib/config/appMode.ts). Deliberately loud: the spec
 * rule this enforces is "sample data may never be mistaken for a real
 * trade," and a quiet badge buried in a table is not enough for that.
 */
export default function DevModeBanner({ appMode }: { appMode: string | undefined }) {
  // Fail toward showing the banner: hide it only once we've positively
  // confirmed production mode from the API, never merely because appMode
  // hasn't loaded yet.
  if (appMode === "production") return null;
  return (
    <div className="rounded-md border-2 border-watch bg-watch/15 px-4 py-2 text-center text-xs font-bold uppercase tracking-wide text-watch">
      Development Mode — Sample Fallbacks May Be Present — Do Not Use For Live Trading
    </div>
  );
}
