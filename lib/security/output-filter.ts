import { startActiveObservation } from "@langfuse/tracing";
import type {
  Citation,
  RetrievedChunk,
  SupportedLanguage,
} from "@/lib/contracts/retrieval";

export type PiiRedactionMode = "off" | "numbers_safe" | "strict";

// Deliberately NOT read from lib/config/env here: this module is a pure
// function of its inputs and is imported by unit tests that run without a
// validated environment. Callers that have env in scope pass
// env.RAG_PII_REDACTION explicitly; this is the fallback and matches its
// default, so a call site that omits it still gets the safe behaviour.
const DEFAULT_PII_REDACTION_MODE: PiiRedactionMode = "numbers_safe";

export type OutputFilterResult = {
  answer: string;
  citations: Citation[];
  blocked: boolean;
  filtered: boolean;
  reasons: string[];
  redactionCount: number;
};

const PROMPT_LEAK_PATTERNS = [
  /\b(?:here(?:'s| is)|below is|revealing|showing)\b.{0,40}\b(?:system prompt|developer message|hidden instructions?|internal prompt)\b/i,
  /\b(?:system prompt|developer message|hidden instructions?|internal policy|chain[- ]of[- ]thought|reasoning trace)\b/i,
  /<(?:system|assistant|developer|tool)>/i,
  /\bBEGIN (?:SYSTEM|DEVELOPER|PROMPT)\b/i,
  /\brole:\s*(?:system|assistant|developer|tool)\b/i,
];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
  /\b(?:api[_ -]?key|secret|token|password|credential)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?\b/gi,
];

// PII redaction. Because retrieved chunk content flows into the answer
// verbatim (that's the point of RAG — the model is instructed to ground its
// answer in source text), any PII present in an ingested document (a
// customer's email, phone number, or SSN in a contract or support ticket PDF)
// would otherwise be returned to the requesting user unredacted.
//
// The catch is that "looks like a phone number" and "looks like a figure this
// system exists to surface" are the same shape. The generic grouped-numeral
// pattern below turns `Total: 12 500 000 units shipped.` into
// `Total: [REDACTED] units shipped.` and `Der Betrag betrug 45 000 00 Euro.`
// into `Der Betrag betrug [REDACTED] Euro.` — silently, after citations have
// been attached, so the answer still carries a [n] marker pointing at a chunk
// whose number the user is no longer allowed to see.
//
// Hence RAG_PII_REDACTION. See each pattern for which modes apply it.

// Always applied (except in `off`). Specific enough not to collide with other
// dash-separated numeric identifiers: US SSN (XXX-XX-XXXX), excluding
// SSA-reserved ranges (area 000/666/900-999, group 00, serial 0000).
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

const EMAIL_PATTERN =
  /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g;

// `strict` only. Optional country code, optional parenthesized area code, then
// 2-3 separator-delimited groups. Requires explicit separators between groups
// so plain numeric IDs and page references (which lack them) are not matched.
// The lookaround only excludes adjacent *digits* (not adjacent punctuation) so
// a phone number immediately followed by a sentence-ending period still
// matches. This is the pattern that eats grouped figures.
const PHONE_PATTERN_GENERIC =
  /(?<!\d)(?:\+\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)[-.\s]?)?\d{2,4}[-.\s]\d{3,4}[-.\s]\d{2,4}(?:[-.\s]\d{2,4})?(?!\d)/g;

// `numbers_safe`: an international dialling prefix is a strong enough signal on
// its own. Amounts and identifiers are not written with a leading `+CC`.
const PHONE_PATTERN_INTERNATIONAL =
  /(?<!\d)\+\d{1,3}[-.\s]?(?:\(\d{2,4}\)[-.\s]?)?\d{2,4}[-.\s]?\d{3,4}(?:[-.\s]?\d{2,4})?(?!\d)/g;

// `numbers_safe`: otherwise a grouped numeral is a phone number only when an
// explicit cue says so. The gap is deliberately short — a wide window is how
// the false-positive problem comes back, since any paragraph mentioning a
// telephone would then redact every figure after it.
const PHONE_PATTERN_CONTEXTUAL =
  /(?<=\b(?:tel|telefon|telephone|phone|mobil|mobile|handy|fax)\b\.?[^\p{L}\p{N}]{0,4})(?:\(\d{2,4}\)[-.\s]?)?\d{2,4}[-.\s]\d{3,4}(?:[-.\s]\d{2,4})?(?!\d)/giu;

/**
 * Email addresses present in the retrieved evidence are not a leak — they are
 * the answer. A procedural document that says "send the request to
 * x@example.org" is useless once that address is redacted out of the answer
 * derived from it, and the caller only sees evidence their RBAC scope already
 * grants them. Addresses the model produced from anywhere else are still
 * redacted.
 */
export function collectEvidenceEmails(
  chunks: readonly RetrievedChunk[],
): Set<string> {
  const emails = new Set<string>();
  for (const chunk of chunks) {
    const haystack = `${chunk.content}\n${chunk.context ?? ""}`;
    for (const match of haystack.matchAll(EMAIL_PATTERN)) {
      emails.add(match[0].toLowerCase());
    }
  }
  return emails;
}

const DANGEROUS_HTML_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?>[\s\S]*?<\/style>/gi,
  /<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi,
  /<object[\s\S]*?>[\s\S]*?<\/object>/gi,
  /<embed[\s\S]*?>/gi,
  /<!--[\s\S]*?-->/g,
];

const REFUSAL_BY_LANGUAGE: Record<SupportedLanguage, string> = {
  EN: "I can provide grounded help with the document content, but I cannot return hidden prompts, internal instructions, secrets, or unsafe executable output.",
  DE: "Ich kann inhaltlich beim Dokument helfen, aber ich kann keine verborgenen Prompts, internen Anweisungen, Geheimnisse oder unsicheren ausführbaren Inhalte ausgeben.",
  FR: "Je peux aider sur le contenu du document, mais je ne peux pas renvoyer de prompts cachés, d'instructions internes, de secrets ou de sortie exécutable non sûre.",
  IT: "Posso aiutare con il contenuto del documento, ma non posso restituire prompt nascosti, istruzioni interne, segreti o output eseguibile non sicuro.",
  ES: "Puedo ayudar con el contenido del documento, pero no puedo devolver prompts ocultos, instrucciones internas, secretos ni salida ejecutable insegura.",
};

// See lib/security/prompt-injection.ts's stripControlChars for why zero-width
// and Unicode format characters are stripped alongside ASCII control chars:
// they let an attacker split an otherwise-matched phrase (e.g. a leaked system
// prompt marker) into invisible fragments that a plain regex won't match while
// still rendering identically to a human reader. This also covers bidi
// embedding/override/isolate controls (U+202A-U+202E, U+2066-U+2069) and the
// Unicode Tag block (U+E0000-U+E007F) — both admit the identical bypass and
// were missed by the original zero-width-only fix (see prompt-injection.ts
// for the full rationale, including the "ASCII smuggling" LLM technique the
// Tag block enables).
function stripControlChars(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu,
    " ",
  );
}

function sanitizeMarkdownLinks(value: string): {
  value: string;
  redactionCount: number;
} {
  let redactionCount = 0;
  const sanitized = value.replace(
    /(!?\[[^\]]*])\(([^)]+)\)/g,
    (match, label, rawUrl) => {
      const url = rawUrl.trim();
      if (/^(?:javascript|data|vbscript|file):/i.test(url)) {
        redactionCount += 1;
        return `${label}(#)`;
      }
      return match;
    },
  );

  return { value: sanitized, redactionCount };
}

function redactSecrets(value: string): {
  value: string;
  redactionCount: number;
} {
  let current = value;
  let redactionCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    current = current.replace(pattern, () => {
      redactionCount += 1;
      return "[REDACTED]";
    });
  }

  return { value: current, redactionCount };
}

export type PiiRedactionOptions = {
  mode?: PiiRedactionMode;
  /** Lowercased addresses found in the retrieved evidence; never redacted. */
  evidenceEmails?: ReadonlySet<string>;
};

function redactPii(
  value: string,
  options: PiiRedactionOptions = {},
): { value: string; redactionCount: number } {
  const mode = options.mode ?? DEFAULT_PII_REDACTION_MODE;
  if (mode === "off") {
    return { value, redactionCount: 0 };
  }

  let current = value;
  let redactionCount = 0;

  const replace = (pattern: RegExp) => {
    current = current.replace(pattern, () => {
      redactionCount += 1;
      return "[REDACTED]";
    });
  };

  replace(SSN_PATTERN);

  if (mode === "strict") {
    replace(EMAIL_PATTERN);
    replace(PHONE_PATTERN_GENERIC);
    return { value: current, redactionCount };
  }

  const evidenceEmails = options.evidenceEmails;
  current = current.replace(EMAIL_PATTERN, (match) => {
    if (evidenceEmails?.has(match.toLowerCase())) {
      return match;
    }
    redactionCount += 1;
    return "[REDACTED]";
  });

  replace(PHONE_PATTERN_INTERNATIONAL);
  replace(PHONE_PATTERN_CONTEXTUAL);

  return { value: current, redactionCount };
}

function sanitizeHtml(value: string): {
  value: string;
  redactionCount: number;
} {
  let current = value;
  let redactionCount = 0;

  for (const pattern of DANGEROUS_HTML_PATTERNS) {
    current = current.replace(pattern, () => {
      redactionCount += 1;
      return "";
    });
  }

  return { value: current, redactionCount };
}

/**
 * Detects a degenerate generation loop, not merely repetitive-looking prose.
 *
 * Measured by character mass rather than line count. The line-count ratio this
 * used to compute is not safe now that RAG_LLM_MAX_OUTPUT_TOKENS allows
 * genuinely long structured answers: eight `## …` headings and eight
 * `Limitations` labels across eight substantive sections drag the unique-line
 * ratio to 0.42 while every word of the actual content is distinct — and the
 * penalty here is a hard refusal, not a warning.
 *
 * What distinguishes a real loop is that the repeated text is most of the
 * output, so weighting each distinct line by its length separates the two
 * cleanly: the structured answer above scores 0.80, a line repeated seven
 * times scores 0.14.
 */
function hasExcessiveRepetition(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 6) {
    return false;
  }

  const distinctLines = new Set(lines);
  const totalChars = lines.reduce((sum, line) => sum + line.length, 0);
  if (totalChars === 0) {
    return false;
  }

  const distinctChars = [...distinctLines].reduce(
    (sum, line) => sum + line.length,
    0,
  );

  return distinctChars / totalChars < 0.55;
}

// Absolute byte-level backstop, distinct from RAG_LLM_MAX_OUTPUT_TOKENS. It
// must sit well clear of the token ceiling or it becomes the binding limit and
// the raised ceiling buys nothing: 2,000 tokens is ~8,000 characters of
// English and more of German, against the 6,000 this used to cut at.
const MAX_ANSWER_CHARS = 24_000;

function trimForSafety(value: string): { value: string; truncated: boolean } {
  const compact = value.trim();
  if (compact.length <= MAX_ANSWER_CHARS) {
    return { value: compact, truncated: false };
  }
  return {
    value: `${compact.slice(0, MAX_ANSWER_CHARS - 100).trimEnd()}\n\n[Output truncated for safety]`,
    truncated: true,
  };
}

export function buildOutputFilterRefusal(language: SupportedLanguage): string {
  return REFUSAL_BY_LANGUAGE[language];
}

export type StreamedSentenceResult = {
  text: string;
  /** A prompt-leak signature was detected; stop emitting further sentences. */
  halted: boolean;
};

/**
 * Per-sentence redaction pass for streamed delivery. Applies every redaction
 * the full filter applies (secrets, PII, HTML, unsafe links) before a
 * sentence reaches the client, and halts the stream on prompt-leak
 * signatures. Whole-answer checks (repetition, truncation, empty-result)
 * still run in filterAnswerOutput on the complete answer, whose result is
 * authoritative — the client replaces streamed text with the `final` event.
 */
export function redactStreamedSentence(
  sentence: string,
  pii: PiiRedactionOptions = {},
): StreamedSentenceResult {
  const normalized = stripControlChars(sentence.normalize("NFKC"));

  if (PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { text: "", halted: true };
  }

  let value = redactSecrets(normalized).value;
  value = redactPii(value, pii).value;
  value = sanitizeHtml(value).value;
  value = sanitizeMarkdownLinks(value).value;

  return { text: value, halted: false };
}

/**
 * Redaction pass for payloads leaving the process as observability data.
 *
 * Deliberately `numbers_safe` rather than `strict`: the strict phone pattern
 * eats grouped figures ("12 500 000" -> "[REDACTED]"), which would destroy
 * exactly the retrieval detail a trace exists to make debuggable. Emails are
 * always redacted here — the evidence-email exemption exists because the
 * caller's own RBAC scope already grants them that address, and a trace
 * exported to a third-party service is outside that scope.
 */
export function maskForTracing(value: string): string {
  const normalized = stripControlChars(value.normalize("NFKC"));
  const withoutSecrets = redactSecrets(normalized).value;
  return redactPii(withoutSecrets, { mode: "numbers_safe" }).value;
}

export function filterAnswerOutput(input: {
  answer: string;
  citations: Citation[];
  language: SupportedLanguage;
  /** Evidence-aware PII redaction; defaults to env config with no evidence. */
  pii?: PiiRedactionOptions;
}): OutputFilterResult {
  return startActiveObservation(
    "filter-output",
    (observation) => {
      observation.update({ input: input.answer });
      const result = filterAnswerOutputUntraced(input);
      observation.update({
        output: result.answer,
        metadata: {
          blocked: result.blocked,
          filtered: result.filtered,
          reasons: result.reasons,
          redactionCount: result.redactionCount,
        },
      });
      return result;
    },
    { asType: "guardrail" },
  );
}

function filterAnswerOutputUntraced(input: {
  answer: string;
  citations: Citation[];
  language: SupportedLanguage;
  pii?: PiiRedactionOptions;
}): OutputFilterResult {
  const reasons: string[] = [];
  let redactionCount = 0;
  const trimmed = trimForSafety(
    stripControlChars(input.answer.normalize("NFKC")),
  );
  let answer = trimmed.value;
  let filtered = trimmed.truncated;

  if (trimmed.truncated) {
    reasons.push("safety_length_truncation");
  }

  if (PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(answer))) {
    return {
      answer: buildOutputFilterRefusal(input.language),
      citations: [],
      blocked: true,
      filtered: true,
      reasons: ["prompt_leak"],
      redactionCount: 0,
    };
  }

  const secretResult = redactSecrets(answer);
  if (secretResult.redactionCount > 0) {
    answer = secretResult.value;
    redactionCount += secretResult.redactionCount;
    filtered = true;
    reasons.push("secret_redaction");
  }

  const piiResult = redactPii(answer, input.pii);
  if (piiResult.redactionCount > 0) {
    answer = piiResult.value;
    redactionCount += piiResult.redactionCount;
    filtered = true;
    reasons.push("pii_redaction");
  }

  const htmlResult = sanitizeHtml(answer);
  if (htmlResult.redactionCount > 0) {
    answer = htmlResult.value;
    redactionCount += htmlResult.redactionCount;
    filtered = true;
    reasons.push("html_sanitized");
  }

  const linkResult = sanitizeMarkdownLinks(answer);
  if (linkResult.redactionCount > 0) {
    answer = linkResult.value;
    redactionCount += linkResult.redactionCount;
    filtered = true;
    reasons.push("unsafe_links_sanitized");
  }

  if (hasExcessiveRepetition(answer)) {
    return {
      answer: buildOutputFilterRefusal(input.language),
      citations: [],
      blocked: true,
      filtered: true,
      reasons: [...reasons, "excessive_repetition"],
      redactionCount,
    };
  }

  const finalAnswer = answer.trim();
  if (!finalAnswer) {
    return {
      answer: buildOutputFilterRefusal(input.language),
      citations: [],
      blocked: true,
      filtered: true,
      reasons: [...reasons, "empty_after_filtering"],
      redactionCount,
    };
  }

  return {
    answer: finalAnswer,
    citations: input.citations,
    blocked: false,
    filtered,
    reasons,
    redactionCount,
  };
}
