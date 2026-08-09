/**
 * Normalises raw environment values before schema validation.
 *
 * Environment values pick up stray whitespace easily — `echo "value" | vercel
 * env add` is enough to append a newline — and every failure that follows is
 * silent rather than loud:
 *
 * - `z.coerce.number()` tolerates it, so numeric settings look fine.
 * - `z.string().url()` accepts it, because WHATWG URL parsing strips trailing
 *   control characters. The stored string keeps the newline, so a URL built by
 *   concatenation is malformed while validation reports success. This is what
 *   broke the production signup redirect: `${NEXT_PUBLIC_APP_URL}/auth/callback`
 *   resolved to `https://host\n/auth/callback`.
 * - The boolean flags compare with `===` against `"true"`/`"1"`, so `"true\n"`
 *   reads as `false` and quietly disables a feature.
 *
 * Normalising centrally rather than per-field means every variable is covered,
 * including ones added later, instead of depending on whoever adds them
 * remembering to attach a `.trim()`.
 *
 * Kept in its own module because `lib/config/env.ts` validates the whole
 * environment at import time and therefore cannot be imported by a unit test.
 */
export function normalizeEnvValues<T extends Record<string, unknown>>(
  raw: T,
): T {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      if (typeof value !== "string") {
        return [key, value];
      }

      const trimmed = value.trim();

      // A whitespace-only value is treated as unset rather than as the empty
      // string, matching the `|| undefined` treatment the optional variables
      // already get. Without this, `.default()` would not apply (defaults fill
      // undefined, not "") and `.optional()` fields would fail `.min(1)`.
      return [key, trimmed === "" ? undefined : trimmed];
    }),
  ) as T;
}
