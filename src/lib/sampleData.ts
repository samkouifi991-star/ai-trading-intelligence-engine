/**
 * A single place that recognizes a sample/fallback-mode source label, so
 * every dashboard badges it the same way instead of each screen guessing at
 * its own string match. Sample sources are always labeled starting with
 * "Sample" (news headlines/stories — see forexFactoryNews.ts's
 * sampleHeadlines) or exactly "sample-fixture" (calendar events — see
 * forexFactoryCalendar.ts's SampleCalendarConnector). Real sources are never
 * labeled this way, so this can't misclassify live data as sample.
 */
export function isSampleSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return source === "sample-fixture" || source.toLowerCase().startsWith("sample");
}
