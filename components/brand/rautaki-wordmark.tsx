/**
 * The Rautaki wordmark.
 *
 * "Rautaki" set in Georgia Regular. The second `a` (position 5) and the `i`
 * (position 7) are gold; every other letter inherits the surface-appropriate
 * base colour. On gold surfaces the relationship inverts — the accent letters
 * become *more* muted than the base. That reversal is intentional.
 *
 * Never recolour it, never add shadows, never change which letters get gold,
 * never set it bold or all-caps, never render below the XS size.
 */

const SIZES = {
  xl: 56,
  md: 36,
  sm: 24,
  xs: 18,
} as const;

export type WordmarkSize = keyof typeof SIZES;

const GOLD_LETTER_INDICES = new Set([4, 6]);
const LETTERS = "Rautaki".split("");

/** The tagline is only ever set at MD or larger. */
const TAGLINE_SIZES: readonly WordmarkSize[] = ["xl", "md"];

type RautakiWordmarkProps = {
  size?: WordmarkSize;
  /** Renders the STRATEGY · ADVISORY · GROWTH lockup beneath the wordmark. */
  tagline?: boolean;
  /** Inverts the accent relationship for placement on a gold surface. */
  onGold?: boolean;
  className?: string;
};

export function RautakiWordmark({
  size = "sm",
  tagline = false,
  onGold = false,
  className = "",
}: RautakiWordmarkProps) {
  const fontSize = SIZES[size];
  const showTagline = tagline && TAGLINE_SIZES.includes(size);

  const baseColor = onGold ? "rgba(0,0,0,0.65)" : "var(--text-primary)";
  const accentColor = onGold ? "rgba(0,0,0,0.28)" : "var(--accent)";

  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span
        aria-label="Rautaki"
        role="img"
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 400,
          fontSize: `${fontSize}px`,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          color: baseColor,
        }}
      >
        {LETTERS.map((letter, index) => (
          <span
            key={index}
            aria-hidden
            style={
              GOLD_LETTER_INDICES.has(index)
                ? { color: accentColor }
                : undefined
            }
          >
            {letter}
          </span>
        ))}
      </span>
      {showTagline && (
        <span
          style={{
            marginTop: `${Math.round(fontSize * 0.28)}px`,
            fontSize: "11px",
            fontWeight: 500,
            letterSpacing: "0.22em",
            lineHeight: 1.4,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            color: onGold ? "rgba(0,0,0,0.45)" : "var(--text-muted)",
          }}
        >
          Strategy · Advisory · Growth
        </span>
      )}
    </span>
  );
}
