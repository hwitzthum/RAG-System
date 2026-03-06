import type { ExtractedPage, RuntimeLogger } from "@/lib/ingestion/runtime/types";
import { inflateRawSync, inflateSync } from "node:zlib";

type PdfJsTextItem = {
  str?: string;
  transform?: number[];
};

type PdfJsPage = {
  getTextContent: () => Promise<{ items: PdfJsTextItem[] }>;
};

type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
};

type PdfJsLoadingTask = {
  promise: Promise<PdfJsDocument>;
  destroy?: () => void;
};

let attemptedNodeCanvasPolyfill = false;

type MatrixLike = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

function normalizeToMatrixLike(value: unknown): MatrixLike {
  if (Array.isArray(value) && value.length >= 6) {
    return {
      a: Number(value[0]) || 1,
      b: Number(value[1]) || 0,
      c: Number(value[2]) || 0,
      d: Number(value[3]) || 1,
      e: Number(value[4]) || 0,
      f: Number(value[5]) || 0,
    };
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<MatrixLike>;
    return {
      a: Number(candidate.a) || 1,
      b: Number(candidate.b) || 0,
      c: Number(candidate.c) || 0,
      d: Number(candidate.d) || 1,
      e: Number(candidate.e) || 0,
      f: Number(candidate.f) || 0,
    };
  }

  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
  };
}

function multiplyMatrices(left: MatrixLike, right: MatrixLike): MatrixLike {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

class MinimalDOMMatrix implements MatrixLike {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor(init?: unknown) {
    const normalized = normalizeToMatrixLike(init);
    this.a = normalized.a;
    this.b = normalized.b;
    this.c = normalized.c;
    this.d = normalized.d;
    this.e = normalized.e;
    this.f = normalized.f;
  }

  multiplySelf(other: unknown): MinimalDOMMatrix {
    const next = multiplyMatrices(this, normalizeToMatrixLike(other));
    this.a = next.a;
    this.b = next.b;
    this.c = next.c;
    this.d = next.d;
    this.e = next.e;
    this.f = next.f;
    return this;
  }

  preMultiplySelf(other: unknown): MinimalDOMMatrix {
    const next = multiplyMatrices(normalizeToMatrixLike(other), this);
    this.a = next.a;
    this.b = next.b;
    this.c = next.c;
    this.d = next.d;
    this.e = next.e;
    this.f = next.f;
    return this;
  }

  translate(tx = 0, ty = 0): MinimalDOMMatrix {
    return this.multiplySelf({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
  }

  scale(scaleX = 1, scaleY = scaleX): MinimalDOMMatrix {
    return this.multiplySelf({ a: scaleX, b: 0, c: 0, d: scaleY, e: 0, f: 0 });
  }

  invertSelf(): MinimalDOMMatrix {
    const determinant = this.a * this.d - this.b * this.c;
    if (!Number.isFinite(determinant) || determinant === 0) {
      this.a = Number.NaN;
      this.b = Number.NaN;
      this.c = Number.NaN;
      this.d = Number.NaN;
      this.e = Number.NaN;
      this.f = Number.NaN;
      return this;
    }

    const a = this.d / determinant;
    const b = -this.b / determinant;
    const c = -this.c / determinant;
    const d = this.a / determinant;
    const e = (this.c * this.f - this.d * this.e) / determinant;
    const f = (this.b * this.e - this.a * this.f) / determinant;

    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    return this;
  }
}

async function ensurePdfJsNodePolyfills(logger: RuntimeLogger): Promise<void> {
  if (attemptedNodeCanvasPolyfill) {
    return;
  }
  attemptedNodeCanvasPolyfill = true;

  const globalScope = globalThis as Record<string, unknown>;
  if (globalScope.DOMMatrix) {
    return;
  }

  globalScope.DOMMatrix = MinimalDOMMatrix as unknown;
  logger.info("pdfjs_dommatrix_polyfill_applied", {
    message: "Applied in-process DOMMatrix polyfill for pdfjs runtime compatibility.",
  });
}

function decodePdfLiteralString(value: string): string {
  let output = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }

    const next = value[index + 1];
    if (!next) {
      break;
    }

    if (next === "n") {
      output += "\n";
      index += 1;
      continue;
    }
    if (next === "r") {
      output += "\r";
      index += 1;
      continue;
    }
    if (next === "t") {
      output += "\t";
      index += 1;
      continue;
    }
    if (next === "b") {
      output += "\b";
      index += 1;
      continue;
    }
    if (next === "f") {
      output += "\f";
      index += 1;
      continue;
    }
    if (next === "(" || next === ")" || next === "\\") {
      output += next;
      index += 1;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let octal = next;
      for (let offset = 2; offset <= 3; offset += 1) {
        const candidate = value[index + offset];
        if (!candidate || candidate < "0" || candidate > "7") {
          break;
        }
        octal += candidate;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    output += next;
    index += 1;
  }

  return output;
}

function decodePdfHexString(value: string): string {
  const cleaned = value.replace(/[^0-9A-Fa-f]/g, "");
  if (!cleaned) {
    return "";
  }

  const evenLengthHex = cleaned.length % 2 === 0 ? cleaned : `${cleaned}0`;
  const bytes = Buffer.from(evenLengthHex, "hex");

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const utf16le = Buffer.from(bytes.subarray(2));
    utf16le.swap16();
    return utf16le.toString("utf16le");
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }

  if (bytes.length % 2 === 0) {
    let likelyUtf16Be = 0;
    for (let index = 0; index < bytes.length; index += 2) {
      if (bytes[index] === 0) {
        likelyUtf16Be += 1;
      }
    }

    if (likelyUtf16Be / (bytes.length / 2) >= 0.3) {
      const utf16le = Buffer.from(bytes);
      utf16le.swap16();
      return utf16le.toString("utf16le");
    }
  }

  return bytes.toString("latin1");
}

function sanitizeExtractedText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTextOperatorsFromContent(content: string): string[] {
  const extracted: string[] = [];
  const textScopes = content.match(/BT[\s\S]*?ET/g) ?? [content];
  const operatorRegex = /(\[(?:\\.|[^\]])*?\]\s*TJ)|((?:\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|'|"))/g;

  for (const scope of textScopes) {
    operatorRegex.lastIndex = 0;
    let match: RegExpExecArray | null = operatorRegex.exec(scope);
    while (match) {
      const arrayOperator = match[1];
      const singleOperator = match[2];

      if (arrayOperator) {
        const body = arrayOperator.slice(1, arrayOperator.lastIndexOf("]"));
        const operandRegex = /\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>/g;
        let operandMatch: RegExpExecArray | null = operandRegex.exec(body);
        while (operandMatch) {
          const token = operandMatch[0];
          if (token.startsWith("(") && token.endsWith(")")) {
            extracted.push(decodePdfLiteralString(token.slice(1, -1)));
          } else if (token.startsWith("<") && token.endsWith(">")) {
            extracted.push(decodePdfHexString(token.slice(1, -1)));
          }
          operandMatch = operandRegex.exec(body);
        }
      } else if (singleOperator) {
        const token = singleOperator.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>/)?.[0] ?? "";
        if (token.startsWith("(") && token.endsWith(")")) {
          extracted.push(decodePdfLiteralString(token.slice(1, -1)));
        } else if (token.startsWith("<") && token.endsWith(">")) {
          extracted.push(decodePdfHexString(token.slice(1, -1)));
        }
      }

      match = operatorRegex.exec(scope);
    }
  }

  return extracted.map((value) => sanitizeExtractedText(value)).filter((value) => value.length > 0);
}

function tryInflateStream(streamBytes: Uint8Array): string {
  try {
    return inflateSync(streamBytes).toString("latin1");
  } catch {
    return inflateRawSync(streamBytes).toString("latin1");
  }
}

function extractTextFromPdfOperators(pdfBytes: Uint8Array, binaryText: string): string {
  const extracted: string[] = [];
  extracted.push(...extractTextOperatorsFromContent(binaryText));

  const streamRegex = /<<[\s\S]*?>>\s*stream\r?\n/g;
  const pdfBuffer = Buffer.from(pdfBytes);
  let streamMatch: RegExpExecArray | null = streamRegex.exec(binaryText);

  while (streamMatch) {
    const dictionary = streamMatch[0];
    const hasFlateFilter = /\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(dictionary);

    if (hasFlateFilter) {
      const streamStart = streamMatch.index + streamMatch[0].length;
      const streamEndToken = binaryText.indexOf("endstream", streamStart);
      if (streamEndToken > streamStart) {
        let streamEnd = streamEndToken;
        while (streamEnd > streamStart && (binaryText[streamEnd - 1] === "\r" || binaryText[streamEnd - 1] === "\n")) {
          streamEnd -= 1;
        }

        if (streamEnd > streamStart) {
          const compressed = pdfBuffer.subarray(streamStart, streamEnd);
          try {
            const inflatedContent = tryInflateStream(compressed);
            extracted.push(...extractTextOperatorsFromContent(inflatedContent));
          } catch {
            // Ignore undecodable stream payloads and continue scanning.
          }
        }
      }
    }

    streamMatch = streamRegex.exec(binaryText);
  }

  return sanitizeExtractedText(extracted.join("\n"));
}

function assemblePageText(items: PdfJsTextItem[]): string {
  const lines: string[] = [];
  let current: string[] = [];
  let lastY: number | null = null;

  for (const item of items) {
    const raw = item.str ?? "";
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    const y = Array.isArray(item.transform) && item.transform.length > 5 ? item.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && current.length > 0) {
      lines.push(current.join(" ").replace(/[ \t]+/g, " ").trim());
      current = [];
    }

    current.push(text);
    if (y !== null) {
      lastY = y;
    }
  }

  if (current.length > 0) {
    lines.push(current.join(" ").replace(/[ \t]+/g, " ").trim());
  }

  return lines.join("\n").trim();
}

async function extractPagesWithPdfJs(pdfBytes: Uint8Array, logger: RuntimeLogger): Promise<ExtractedPage[]> {
  await ensurePdfJsNodePolyfills(logger);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const documentInitParams: Record<string, unknown> = {
    data: pdfBytes,
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  };
  const loadingTask = pdfjs.getDocument(documentInitParams as never) as PdfJsLoadingTask;

  try {
    const document = await loadingTask.promise;
    const pages: ExtractedPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({
        pageNumber,
        text: assemblePageText(content.items),
      });
    }

    return pages;
  } finally {
    if (typeof loadingTask.destroy === "function") {
      loadingTask.destroy();
    }
  }
}

export async function extractPages(
  pdfBytes: Uint8Array,
  enableOcrFallback: boolean,
  logger: RuntimeLogger,
): Promise<ExtractedPage[]> {
  const fallbackBinaryText = Buffer.from(pdfBytes).toString("latin1");

  try {
    const pages = await extractPagesWithPdfJs(new Uint8Array(pdfBytes), logger);
    if (pages.some((page) => page.text.trim().length > 0)) {
      return pages;
    }

    logger.warn("pdfjs_extraction_empty_result", {
      pageCount: pages.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_pdfjs_error";
    logger.warn("pdfjs_extraction_failed", { message });
  }

  const extracted = extractTextFromPdfOperators(pdfBytes, fallbackBinaryText);

  if (extracted) {
    return [
      {
        pageNumber: 1,
        text: extracted,
      },
    ];
  }

  if (enableOcrFallback) {
    logger.warn("ocr_fallback_backend_unavailable", { pageNumber: 1 });
  }

  return [
    {
      pageNumber: 1,
      text: "",
    },
  ];
}
