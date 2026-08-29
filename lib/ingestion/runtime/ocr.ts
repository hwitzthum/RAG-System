import type { RuntimeLogger } from "./types";

/**
 * OCR fallback for pages that carry no text layer (scanned or image-only
 * PDFs). Each page is rasterised with pdfjs onto a Node canvas and
 * transcribed by a vision model. A page comes back as plain text in reading
 * order, so it flows through the same furniture stripping, sectioning and
 * chunking as a native text layer — with its page number intact.
 *
 * Rendering goes through pdfjs's own Node canvas factory, which loads
 * `@napi-rs/canvas` itself. Building the canvas by hand (createCanvas +
 * installing Path2D/DOMMatrix/ImageData globals) renders text-only pages but
 * segfaults the process on the first page that draws an embedded image —
 * exactly the pages OCR exists for.
 */

/** Transcribes one rendered page. Injectable so tests never hit the model. */
export type TranscribePage = (input: {
  png: Buffer;
  pageNumber: number;
}) => Promise<string>;

export type OcrFallback = {
  transcribePage: TranscribePage;
};

/** 1.5x the PDF point size: legible for a vision model, ~1.3k px wide for A4. */
const RENDER_SCALE = 1.5;
/** Pages rendered + transcribed concurrently; bounded by model rate limits. */
const OCR_CONCURRENCY = 3;
const OCR_TIMEOUT_MS = 60_000;

const OCR_SYSTEM_PROMPT =
  "You are an OCR engine. Transcribe ALL text visible in the page image " +
  "exactly as written, in reading order, preserving paragraph breaks and " +
  "headings. Do not summarize, translate, correct or add anything. If the " +
  "page contains no text, output an empty string.";

/**
 * Builds the production transcriber against OpenAI's vision-capable chat
 * models. `detail: "high"` is deliberate: the low-detail tier downsamples to
 * 512px, which loses body text on a full page.
 */
export function createOpenAiTranscriber(input: {
  apiKey: string;
  model: string;
}): TranscribePage {
  return async ({ png }) => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        max_tokens: 4_000,
        messages: [
          { role: "system", content: OCR_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${png.toString("base64")}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
      }),
    });

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `ocr_http_${response.status}`);
    }
    return payload.choices?.[0]?.message?.content?.trim() ?? "";
  };
}

/**
 * Transcribes the requested pages of a PDF. Returns text keyed by page
 * number; a page whose render or transcription fails is logged and omitted,
 * so the caller can tell "no text" from "not attempted".
 */
export async function ocrPages(input: {
  pdfBytes: Uint8Array;
  pageNumbers: number[];
  transcribePage: TranscribePage;
  logger: RuntimeLogger;
}): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  if (input.pageNumbers.length === 0) {
    return results;
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(input.pdfBytes),
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  } as never);

  try {
    const document = await loadingTask.promise;
    const canvasFactory = (
      document as unknown as {
        canvasFactory: {
          create: (
            width: number,
            height: number,
          ) => { canvas: unknown; context: unknown };
          destroy: (target: { canvas: unknown; context: unknown }) => void;
        };
      }
    ).canvasFactory;
    const queue = [...input.pageNumbers];

    const worker = async () => {
      for (;;) {
        const pageNumber = queue.shift();
        if (pageNumber === undefined) {
          return;
        }
        const started = Date.now();
        try {
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const target = canvasFactory.create(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          let png: Buffer;
          try {
            await page.render({
              canvasContext: target.context as never,
              canvas: target.canvas as never,
              viewport,
            }).promise;
            png = (
              target.canvas as { toBuffer: (mime: "image/png") => Buffer }
            ).toBuffer("image/png");
          } finally {
            canvasFactory.destroy(target);
          }
          const text = await input.transcribePage({ png, pageNumber });
          results.set(pageNumber, text);
          input.logger.info("ocr_page_transcribed", {
            pageNumber,
            chars: text.length,
            durationMs: Date.now() - started,
          });
        } catch (error) {
          input.logger.warn("ocr_page_failed", {
            pageNumber,
            message: error instanceof Error ? error.message : "unknown_error",
          });
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(OCR_CONCURRENCY, queue.length) },
        () => worker(),
      ),
    );
  } finally {
    if (typeof loadingTask.destroy === "function") {
      await loadingTask.destroy();
    }
  }

  return results;
}
