/** Small deterministic PRNG (mulberry32) so "sample mode" data is stable
 * across requests within a process run instead of jumping around randomly,
 * which would make the dashboard feel broken. Seed by a time bucket so data
 * still evolves slowly over the day. */
export function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Seed that changes every N minutes, so sample data drifts like a real feed
 * without being purely random on every call. */
export function timeBucketSeed(bucketMinutes: number, salt: string): number {
  const bucket = Math.floor(Date.now() / (bucketMinutes * 60_000));
  return hashString(`${salt}:${bucket}`);
}
