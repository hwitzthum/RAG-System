import type { ExtractedPage, RuntimeLogger } from "@/lib/ingestion/runtime/types";

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

function decodePdfLiteralString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function extractTextFromPdfOperators(binaryText: string): string {
  const matches: string[] = [];
  const regex = /\((?:\\.|[^\\)])*\)\s*Tj/g;

  let match: RegExpExecArray | null = regex.exec(binaryText);
  while (match) {
    const rawLiteral = match[0].replace(/\)\s*Tj$/, "");
    const inner = rawLiteral.startsWith("(") ? rawLiteral.slice(1) : rawLiteral;
    matches.push(decodePdfLiteralString(inner));
    match = regex.exec(binaryText);
  }

  return matches
    .join("\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
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

async function extractPagesWithPdfJs(pdfBytes: Uint8Array): Promise<ExtractedPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: pdfBytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  }) as PdfJsLoadingTask;

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
    const pages = await extractPagesWithPdfJs(new Uint8Array(pdfBytes));
    if (pages.some((page) => page.text.trim().length > 0)) {
      return pages;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_pdfjs_error";
    logger.warn("pdfjs_extraction_failed", { message });
  }

  const extracted = extractTextFromPdfOperators(fallbackBinaryText);

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
