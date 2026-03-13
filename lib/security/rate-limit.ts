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

const PRUNE_THRESHOLD = 1000;

export function createInMemoryRateLimiter(): InMemoryRateLimiter {
  const state = new Map<string, RateState>();
  let callsSincePrune = 0;

  function pruneExpired(now: number) {
    if (state.size <= PRUNE_THRESHOLD) return;
    for (const [key, entry] of state) {
      if (entry.resetAtMs <= now) {
        state.delete(key);
      }
    }
  }

  return {
    consume(key: string, maxRequests: number, windowMs: number): RateLimitDecision {
      const now = Date.now();
      if (++callsSincePrune >= 100) {
        pruneExpired(now);
        callsSincePrune = 0;
      }

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

export type SharedRateLimitOptions = {
  /** When false, returns `{ allowed: false }` if the Supabase RPC fails instead of
   *  falling back to the (possibly empty) in-memory limiter. Use for auth routes. */
  failOpen?: boolean;
};

/**
 * Shared rate limiter that calls the Supabase `consume_rate_limit` RPC.
 * Falls back to in-memory if the RPC call fails (unless `failOpen: false`).
 */
export async function consumeSharedRateLimit(
  bucketKey: string,
  maxRequests: number,
  windowSeconds: number,
  options: SharedRateLimitOptions = {},
): Promise<RateLimitDecision> {
  const { failOpen = true } = options;

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
  } catch (error) {
    console.warn("rate_limit_rpc_fallback", {
      bucketKey,
      failOpen,
      error: error instanceof Error ? error.message : String(error),
    });

    if (!failOpen) {
      return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
    }

    return fallbackLimiter.consume(bucketKey, maxRequests, windowSeconds * 1000);
  }
}
