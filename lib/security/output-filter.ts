import type { Citation, SupportedLanguage } from "@/lib/contracts/retrieval";

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

function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

function sanitizeMarkdownLinks(value: string): { value: string; redactionCount: number } {
  let redactionCount = 0;
  const sanitized = value.replace(/(!?\[[^\]]*])\(([^)]+)\)/g, (match, label, rawUrl) => {
    const url = rawUrl.trim();
    if (/^(?:javascript|data|vbscript|file):/i.test(url)) {
      redactionCount += 1;
      return `${label}(#)`;
    }
    return match;
  });

  return { value: sanitized, redactionCount };
}

function redactSecrets(value: string): { value: string; redactionCount: number } {
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

function sanitizeHtml(value: string): { value: string; redactionCount: number } {
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

function hasExcessiveRepetition(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 6) {
    return false;
  }

  const unique = new Set(lines);
  return unique.size / lines.length < 0.55;
}

function trimForSafety(value: string): string {
  const compact = value.trim();
  if (compact.length <= 6_000) {
    return compact;
  }
  return `${compact.slice(0, 5_900).trimEnd()}\n\n[Output truncated for safety]`;
}

export function buildOutputFilterRefusal(language: SupportedLanguage): string {
  return REFUSAL_BY_LANGUAGE[language];
}

export function filterAnswerOutput(input: {
  answer: string;
  citations: Citation[];
  language: SupportedLanguage;
}): OutputFilterResult {
  const reasons: string[] = [];
  let redactionCount = 0;
  let answer = trimForSafety(stripControlChars(input.answer.normalize("NFKC")));
  let filtered = false;

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
