type RateState = {
  count: number;
  resetAtMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type InMemoryRateLimiter = {
  consume: (key: string, maxRequests: number, windowMs: number) => RateLimitDecision;
};

export function createInMemoryRateLimiter(): InMemoryRateLimiter {
  const state = new Map<string, RateState>();

  return {
    consume(key: string, maxRequests: number, windowMs: number): RateLimitDecision {
      const now = Date.now();
      const existing = state.get(key);

      if (!existing || existing.resetAtMs <= now) {
        state.set(key, {
          count: 1,
          resetAtMs: now + windowMs,
        });

        return {
          allowed: true,
          remaining: Math.max(maxRequests - 1, 0),
          retryAfterSeconds: Math.ceil(windowMs / 1000),
        };
      }

      existing.count += 1;

      if (existing.count > maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(Math.ceil((existing.resetAtMs - now) / 1000), 1),
        };
      }

      return {
        allowed: true,
        remaining: Math.max(maxRequests - existing.count, 0),
        retryAfterSeconds: Math.max(Math.ceil((existing.resetAtMs - now) / 1000), 1),
      };
    },
  };
}

export const queryRateLimiter = createInMemoryRateLimiter();
