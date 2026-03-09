/**
 * Shared colour palette and text parsing for DOCX and PDF report generators.
 */

/* ── colour palette ─────────────────────────────────────── */

/** Hex colours WITH # prefix (for pdfkit) */
export const COLORS = {
  primary: "#1A365D",
  accent: "#2B6CB0",
  muted: "#718096",
  body: "#2D3748",
  light: "#EDF2F7",
  border: "#CBD5E0",
  sourceContent: "#4A5568",
} as const;

/** Same palette WITHOUT # prefix (for docx library) */
export const COLORS_DOCX = {
  primary: "1A365D",
  accent: "2B6CB0",
  muted: "718096",
  body: "2D3748",
  light: "EDF2F7",
  border: "CBD5E0",
  sourceContent: "4A5568",
} as const;

/* ── answer text parsing ─────────────────────────────────── */

const BULLET_RE = /^[-•*]\s+(.*)/;
const NUMBERED_RE = /^(\d+)[.)]\s+(.*)/;
const MAX_SUBHEADING_LEN = 80;
const MAX_SUBHEADING_WORDS = 10;

export type ParsedBlock =
  | { type: "bullet"; content: string }
  | { type: "numbered"; number: string; content: string }
  | { type: "subheading"; content: string }
  | { type: "body"; content: string };

/**
 * Splits an LLM answer string into structured blocks for rendering.
 * Detects bullets, numbered lists, sub-headings, and body paragraphs.
 */
export function parseAnswerBlocks(text: string): ParsedBlock[] {
  return text
    .split(/\n{2,}/)
    .filter((l) => l.trim())
    .map((line): ParsedBlock => {
      const trimmed = line.trim();

      const bulletMatch = trimmed.match(BULLET_RE);
      if (bulletMatch) {
        return { type: "bullet", content: bulletMatch[1] };
      }

      const numberedMatch = trimmed.match(NUMBERED_RE);
      if (numberedMatch) {
        return { type: "numbered", number: numberedMatch[1], content: numberedMatch[2] };
      }

      if (
        trimmed.length < MAX_SUBHEADING_LEN &&
        !trimmed.endsWith(".") &&
        !trimmed.includes("\n") &&
        trimmed.split(" ").length <= MAX_SUBHEADING_WORDS
      ) {
        return { type: "subheading", content: trimmed };
      }

      return { type: "body", content: trimmed };
    });
}

/* ── date formatting ─────────────────────────────────────── */

export function formatReportDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
