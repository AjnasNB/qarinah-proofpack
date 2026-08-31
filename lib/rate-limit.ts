interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

function prune(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, value] of buckets) {
    if (value.resetAt <= now) buckets.delete(key);
    if (buckets.size < MAX_BUCKETS * 0.8) break;
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
  prune(now);
  const existing = buckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : existing;
  bucket.count += 1;
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
