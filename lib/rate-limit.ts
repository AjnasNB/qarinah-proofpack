interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
export const MAX_RATE_LIMIT_BUCKETS = 5_000;
const EVICTION_LOW_WATER_MARK = Math.floor(MAX_RATE_LIMIT_BUCKETS * 0.8);

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

function ensureCapacity(key: string, now: number): void {
  if (buckets.size < MAX_RATE_LIMIT_BUCKETS) return;

  for (const [bucketKey, value] of buckets) {
    if (value.resetAt <= now) buckets.delete(bucketKey);
  }

  const needsNewBucket = !buckets.has(key);
  const maximumSizeBeforeWrite = needsNewBucket
    ? MAX_RATE_LIMIT_BUCKETS - 1
    : MAX_RATE_LIMIT_BUCKETS;
  if (buckets.size <= maximumSizeBeforeWrite) return;

  // Map iteration order is access order because checkRateLimit moves every
  // touched bucket to the end. Evicting from the front is therefore a
  // deterministic LRU policy. The low-water mark avoids a full-map scan for
  // every new key during a burst of unique clients.
  const targetSize = needsNewBucket
    ? EVICTION_LOW_WATER_MARK
    : MAX_RATE_LIMIT_BUCKETS;
  for (const candidate of buckets.keys()) {
    if (candidate === key) continue;
    buckets.delete(candidate);
    if (buckets.size <= targetSize) break;
  }
}

export function checkRateLimit(
  key: string,
  options: { limit?: number; windowMs?: number; now?: number } = {}
): RateLimitResult {
  const limit = options.limit ?? 20;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now();
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new TypeError("Rate limit and window must be positive integers.");
  }
  ensureCapacity(key, now);
  const existing = buckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : existing;
  bucket.count += 1;
  buckets.delete(key);
  buckets.set(key, bucket);
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt
  };
}

export function clearRateLimits(): void {
  buckets.clear();
}
