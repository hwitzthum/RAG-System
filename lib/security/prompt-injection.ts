import type { RetrievedChunk, SupportedLanguage } from "@/lib/contracts/retrieval";
import type { WebSource } from "@/lib/web-research/types";

type PromptInjectionRule = {
  label: string;
  pattern: RegExp;
  score: number;
};

export type PromptInjectionScan = {
  score: number;
  matchedLabels: string[];
  suspicious: boolean;
  blocked: boolean;
};

export type ProtectedChunksResult = {
  chunks: RetrievedChunk[];
  suspiciousCount: number;
  blockedCount: number;
};

export type ProtectedWebSourcesResult = {
  webSources: WebSource[];
  suspiciousCount: number;
  blockedCount: number;
};

const PROMPT_INJECTION_RULES: PromptInjectionRule[] = [
  { label: "instruction_override", pattern: /\bignore (?:all|any|the|these|previous|prior|above) (?:instructions|directions|rules)\b/i, score: 6 },
  { label: "role_override", pattern: /\byou are now\b|\bact as\b|\bnew role\b/i, score: 5 },
  { label: "system_prompt_exfiltration", pattern: /\bsystem prompt\b|\bdeveloper message\b|\bhidden instructions\b|\brepeat (?:everything|all|the text) (?:above|before) this (?:line|point)\b/i, score: 7 },
  { label: "secret_exfiltration", pattern: /\bapi key\b|\bsecret\b|\btoken\b|\bcredential\b|\bpassword\b/i, score: 7 },
  { label: "tool_or_browse_command", pattern: /\bbrowse the web\b|\buse the tool\b|\bcall the tool\b|\bexecute code\b|\brun command\b/i, score: 6 },
  { label: "prompt_delimiter_markup", pattern: /<(?:system|assistant|developer|tool)>|BEGIN (?:SYSTEM|DEVELOPER|PROMPT)|role:\s*(?:system|assistant|developer|tool)|#{2,}\s*(?:SYSTEM|DEVELOPER|ASSISTANT|TOOL)\s*:/i, score: 6 },
  { label: "data_exfiltration", pattern: /\bexfiltrat\w*\b|\bleak\b|\breveal\b.*\bprompt\b/i, score: 7 },
  { label: "jailbreak_phrasing", pattern: /\bdo not follow\b.*\bpolicy\b|\boverride safety\b|\bjailbreak\b|\bpretend you have no (?:content policy|restrictions|rules)\b|\byou have no restrictions\b/i, score: 7 },
  // README-documented category: coercing the model to encode its answer so that
  // downstream output filtering (which matches plaintext patterns) cannot inspect it.
  { label: "output_format_manipulation", pattern: /\b(?:respond|answer|reply|output)\b[^\n.!?]{0,40}\bonly in\b[^\n.!?]{0,10}\b(?:base64|rot13|hex(?:adecimal)?|binary|morse(?: code)?)\b|\bencode your (?:response|answer|reply) (?:in|as|using)\b/i, score: 5 },
  // README-documented category: fabricated multi-turn Q&A / Human-Assistant transcripts
  // embedded in content to condition the model into treating them as prior turns.
  { label: "few_shot_poisoning", pattern: /(?:^|\n)\s*Q\s*:\s*.+\n\s*A\s*:\s*.+\n\s*Q\s*:\s*.+\n\s*A\s*:/i, score: 5 },
  { label: "few_shot_poisoning", pattern: /(?:^|\n)\s*(?:human|user)\s*:\s*.+\n\s*(?:assistant|ai)\s*:\s*.+\n\s*(?:human|user)\s*:/i, score: 5 },
  // README-documented category: the same instruction-override intent, phrased in the
  // other languages this app explicitly supports (DE/FR/IT/ES) so a scanner that only
  // matches English phrasing is trivially bypassed by non-English documents/queries.
  {
    label: "multi_language_evasion",
    pattern:
      /\bignoriere alle (?:vorherigen |vorangegangenen )?anweisungen\b|\bignorez? toutes les instructions(?: pr[ée]c[ée]dentes| ant[ée]rieures)?\b|\bignora tutte le istruzioni(?: precedenti)?\b|\bignora todas las instrucciones(?: anteriores| previas)?\b/i,
    score: 6,
  },
];

const OUTPUT_LEAK_RULES = [
  /\bhere(?:'s| is) (?:the )?(?:system prompt|developer message)\b/i,
  /\bapi key\b/i,
  /\bsecret token\b/i,
];

const REFUSAL_BY_LANGUAGE: Record<SupportedLanguage, string> = {
  EN: "I can help with the document content, but I cannot follow instructions that try to override system rules, reveal hidden prompts, or expose secrets.",
  DE: "Ich kann beim Dokumentinhalt helfen, aber ich kann keine Anweisungen befolgen, die Systemregeln überschreiben, verborgene Prompts offenlegen oder Geheimnisse preisgeben sollen.",
  FR: "Je peux aider sur le contenu du document, mais je ne peux pas suivre des instructions visant à contourner les règles système, révéler des prompts cachés ou exposer des secrets.",
  IT: "Posso aiutare con il contenuto del documento, ma non posso seguire istruzioni che tentano di aggirare le regole di sistema, rivelare prompt nascosti o esporre segreti.",
  ES: "Puedo ayudar con el contenido del documento, pero no puedo seguir instrucciones que intenten anular las reglas del sistema, revelar prompts ocultos o exponer secretos.",
};

// Strips ASCII control characters plus Unicode zero-width/format characters
// (zero-width space/non-joiner/joiner, LTR/RTL marks, word joiner, soft
// hyphen, and the zero-width no-break space / BOM). Regex-based scanners
// match on visible substrings; an attacker can defeat them by interleaving
// these invisible characters inside an otherwise-flagged phrase (splitting
// "ignore all instructions" with zero-width spaces renders identically to a
// human reader but no longer matches the instruction_override pattern).
// Removing them before matching closes that gap without changing anything
// visible to a human reader.
function stripControlChars(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2060\uFEFF]/g,
    " ",
  );
}

function redactInjectionLines(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => {
      const scan = scanPromptInjection(line);
      return !scan.suspicious;
    })
    .join("\n")
    .trim();
}

// Labels for rules whose patterns are strong standalone indicators of
// prompt injection. A single match at this confidence level is treated as
// a block without requiring score accumulation to reach the compound threshold.
const HIGH_CONFIDENCE_BLOCK_LABELS = new Set([
  "system_prompt_exfiltration",
  "secret_exfiltration",
  "data_exfiltration",
  "jailbreak_phrasing",
]);

export function scanPromptInjection(value: string): PromptInjectionScan {
  const normalized = stripControlChars(value.normalize("NFKC"));
  const matchedRules = PROMPT_INJECTION_RULES.filter((rule) => rule.pattern.test(normalized));
  const matchedLabels = matchedRules.map((rule) => rule.label);
  const score = matchedRules.reduce((sum, rule) => sum + rule.score, 0);

  const hasHighConfidenceMatch = matchedLabels.some((label) => HIGH_CONFIDENCE_BLOCK_LABELS.has(label));

  return {
    score,
    matchedLabels,
    suspicious: score >= 5,
    // Block if compound score threshold is met OR if any single high-confidence
    // rule matches (score ≥ 7). This closes the gap where a single strong
    // indicator like "system prompt" or "api key" was only flagged as suspicious
    // despite being an unambiguous injection attempt.
    blocked: score >= 10 || hasHighConfidenceMatch,
  };
}

export function sanitizePromptPayload(value: string, fallbackLabel: string): string {
  const cleaned = stripControlChars(value).trim();
  if (!cleaned) {
    return `[No ${fallbackLabel} available]`;
  }

  const scan = scanPromptInjection(cleaned);
  if (!scan.suspicious) {
    return cleaned;
  }

  const redacted = redactInjectionLines(cleaned);
  if (!redacted) {
    return `[Potential prompt injection content removed from ${fallbackLabel}]`;
  }

  if (scan.blocked) {
    return `[Potential prompt injection content removed from ${fallbackLabel}]\n${redacted}`;
  }

  return redacted;
}

export function protectRetrievedChunks(chunks: RetrievedChunk[]): ProtectedChunksResult {
  let suspiciousCount = 0;
  let blockedCount = 0;

  return {
    chunks: chunks.map((chunk) => {
      const combinedScan = scanPromptInjection(`${chunk.sectionTitle}\n${chunk.content}\n${chunk.context}`);
      if (combinedScan.suspicious) {
        suspiciousCount += 1;
      }
      if (combinedScan.blocked) {
        blockedCount += 1;
      }

      const sanitizedContent = sanitizePromptPayload(chunk.content, `document chunk ${chunk.chunkId}`);
      const sanitizedContext = sanitizePromptPayload(chunk.context, `document context ${chunk.chunkId}`);
      return {
        ...chunk,
        content: sanitizedContent,
        context: sanitizedContext,
      };
    }),
    suspiciousCount,
    blockedCount,
  };
}

export function protectWebSources(webSources: WebSource[]): ProtectedWebSourcesResult {
  let suspiciousCount = 0;
  let blockedCount = 0;

  return {
    webSources: webSources.map((source, index) => {
      const combinedScan = scanPromptInjection(`${source.title}\n${source.snippet}`);
      if (combinedScan.suspicious) {
        suspiciousCount += 1;
      }
      if (combinedScan.blocked) {
        blockedCount += 1;
      }

      return {
        ...source,
        title: sanitizePromptPayload(source.title, `web source title ${index + 1}`),
        snippet: sanitizePromptPayload(source.snippet, `web source snippet ${index + 1}`),
      };
    }),
    suspiciousCount,
    blockedCount,
  };
}

export function shouldBlockUserPrompt(value: string): boolean {
  return scanPromptInjection(value).blocked;
}

export function buildPromptInjectionRefusal(language: SupportedLanguage): string {
  return REFUSAL_BY_LANGUAGE[language];
}

export function containsSensitiveLeakage(value: string): boolean {
  return OUTPUT_LEAK_RULES.some((pattern) => pattern.test(value));
}
