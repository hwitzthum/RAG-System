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

const fallbackLimiter = createInMemoryRateLimiter();

/**
 * Shared rate limiter that calls the Supabase `consume_rate_limit` RPC.
 * Falls back to in-memory if the RPC call fails.
 */
export async function consumeSharedRateLimit(
  bucketKey: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  try {
    // Lazy import to avoid triggering env validation in unit tests
    const { getSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const supabase = getSupabaseAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("consume_rate_limit", {
      bucket_key_input: bucketKey,
      max_requests_input: maxRequests,
      window_seconds_input: windowSeconds,
    });

    if (error) {
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error("Empty response from consume_rate_limit");
    }

    return {
      allowed: row.allowed as boolean,
      remaining: row.remaining as number,
      retryAfterSeconds: row.retry_after_seconds as number,
    };
  } catch {
    // Fall back to in-memory limiter if Supabase RPC fails.
    return fallbackLimiter.consume(bucketKey, maxRequests, windowSeconds * 1000);
  }
}

// Keep the legacy in-memory limiter export for backwards compatibility
// and for use cases where async is not desired.
export const queryRateLimiter = createInMemoryRateLimiter();
