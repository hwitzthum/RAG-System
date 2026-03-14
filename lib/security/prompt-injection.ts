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
  { label: "system_prompt_exfiltration", pattern: /\bsystem prompt\b|\bdeveloper message\b|\bhidden instructions\b/i, score: 7 },
  { label: "secret_exfiltration", pattern: /\bapi key\b|\bsecret\b|\btoken\b|\bcredential\b|\bpassword\b/i, score: 7 },
  { label: "tool_or_browse_command", pattern: /\bbrowse the web\b|\buse the tool\b|\bcall the tool\b|\bexecute code\b|\brun command\b/i, score: 6 },
  { label: "prompt_delimiter_markup", pattern: /<(?:system|assistant|developer|tool)>|BEGIN (?:SYSTEM|DEVELOPER|PROMPT)|role:\s*(?:system|assistant|developer|tool)/i, score: 6 },
  { label: "data_exfiltration", pattern: /\bexfiltrat\w*\b|\bleak\b|\breveal\b.*\bprompt\b/i, score: 7 },
  { label: "jailbreak_phrasing", pattern: /\bdo not follow\b.*\bpolicy\b|\boverride safety\b|\bjailbreak\b/i, score: 7 },
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

function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
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

export function scanPromptInjection(value: string): PromptInjectionScan {
  const normalized = stripControlChars(value.normalize("NFKC"));
  const matchedLabels = PROMPT_INJECTION_RULES
    .filter((rule) => rule.pattern.test(normalized))
    .map((rule) => rule.label);
  const score = PROMPT_INJECTION_RULES
    .filter((rule) => rule.pattern.test(normalized))
    .reduce((sum, rule) => sum + rule.score, 0);

  return {
    score,
    matchedLabels,
    suspicious: score >= 5,
    blocked: score >= 10,
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
