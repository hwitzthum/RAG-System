import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import {
  chunkSections,
  countTokens,
  splitPagesIntoSections,
} from "@/lib/ingestion/runtime/chunking";
import { ContextGenerator } from "@/lib/ingestion/runtime/context-generator";
import { EmbeddingProvider } from "@/lib/ingestion/runtime/embedding-provider";
import { createOpenAiTranscriber } from "@/lib/ingestion/runtime/ocr";
import { extractPages } from "@/lib/ingestion/runtime/pdf-extractor";
import { stripPageFurniture } from "@/lib/ingestion/runtime/page-furniture";
import type {
  ChunkCandidate,
  DocumentRecord,
  IngestionJob,
  IngestionRuntimeSettings,
  JobProgress,
  PreparedChunkRecord,
  ProcessJobResult,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";
import type { IngestionRuntimeRepository } from "@/lib/ingestion/runtime/repository";
import type { SupportedLanguage } from "@/lib/supabase/database.types";
import { detectLanguageWithConfidence } from "@/lib/retrieval/language";

/**
 * Assigns a language to every section of a document.
 *
 * Per-section detection on its own is unreliable, in two ways that both used to
 * resolve silently to German:
 *
 *  - A heading like "COORDINATION & CAPACITY" matches no keyword in any
 *    language. Every language scored 0 and, with the accumulator seeded at -1,
 *    whichever language was declared first in the table won — German. English
 *    headings were labelled German.
 *  - Several keywords are shared between languages (" des " is both German and
 *    French), so a tie is a genuine "don't know". Two unmistakably German
 *    chunks were labelled French this way.
 *
 * Sections without clear evidence now inherit the document's language rather
 * than being guessed at. When the document has no language yet (first
 * ingestion), the majority verdict of the sections that *were* confident stands
 * in — a far better prior for a short fragment than the fragment itself.
 * Confident sections keep their own language, so genuinely multilingual
 * documents still chunk per language.
 */
export function assignSectionLanguages(
  sections: { text: string }[],
  languageHint: SupportedLanguage | null,
): SupportedLanguage[] {
  if (languageHint) {
    return sections.map(() => languageHint);
  }

  const detections = sections.map((section) =>
    detectLanguageWithConfidence(section.text),
  );

  const confidentCounts = new Map<SupportedLanguage, number>();
  for (const detection of detections) {
    if (detection.confident) {
      confidentCounts.set(
        detection.language,
        (confidentCounts.get(detection.language) ?? 0) + 1,
      );
    }
  }

  let fallbackLanguage: SupportedLanguage = "EN";
  let fallbackCount = 0;
  for (const [language, count] of confidentCounts.entries()) {
    if (count > fallbackCount) {
      fallbackCount = count;
      fallbackLanguage = language;
    }
  }

  return detections.map((detection) =>
    detection.confident ? detection.language : fallbackLanguage,
  );
}

function determineDocumentLanguage(
  chunkLanguages: SupportedLanguage[],
  fallback: SupportedLanguage | null,
): SupportedLanguage {
  if (fallback) {
    return fallback;
  }
  if (chunkLanguages.length === 0) {
    return "EN";
  }

  const counts = new Map<SupportedLanguage, number>();
  for (const language of chunkLanguages) {
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  let selected: SupportedLanguage = "EN";
  let selectedCount = -1;
  for (const [language, count] of counts.entries()) {
    if (count > selectedCount) {
      selected = language;
      selectedCount = count;
    }
  }

  return selected;
}

function reindexChunks(chunks: ChunkCandidate[]): ChunkCandidate[] {
  return chunks.map((chunk, index) => {
    if (chunk.chunkIndex === index) {
      return chunk;
    }
    return {
      chunkIndex: index,
      pageNumber: chunk.pageNumber,
      sectionTitle: chunk.sectionTitle,
      content: chunk.content,
      language: chunk.language,
    };
  });
}

function buildRelaxedDocumentFallbackChunk(
  sections: { pageNumber: number; sectionTitle: string; text: string }[],
  languageHint: SupportedLanguage | null,
): ChunkCandidate | null {
  const combinedContent = sections
    .map((section) => section.text.trim())
    .filter((value) => value.length > 0)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!combinedContent) {
    return null;
  }

  return {
    chunkIndex: 0,
    pageNumber: sections[0]?.pageNumber ?? 1,
    sectionTitle: "Document",
    content: combinedContent,
    language: assignSectionLanguages(
      [{ text: combinedContent }],
      languageHint,
    )[0]!,
  };
}

function groupSectionsByLanguage(
  sections: {
    pageNumber: number;
    sectionTitle: string;
    text: string;
    language: SupportedLanguage;
  }[],
): Array<{
  language: SupportedLanguage;
  sections: { pageNumber: number; sectionTitle: string; text: string }[];
}> {
  const groups: Array<{
    language: SupportedLanguage;
    sections: { pageNumber: number; sectionTitle: string; text: string }[];
  }> = [];

  for (const section of sections) {
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.language === section.language) {
      currentGroup.sections.push({
        pageNumber: section.pageNumber,
        sectionTitle: section.sectionTitle,
        text: section.text,
      });
      continue;
    }

    groups.push({
      language: section.language,
      sections: [
        {
          pageNumber: section.pageNumber,
          sectionTitle: section.sectionTitle,
          text: section.text,
        },
      ],
    });
  }

  return groups;
}

type ExtractPagesFn = typeof extractPages;
// summarizeDocument is optional so lean test doubles that only stub enrich
// keep working; without it the document simply gets no generated summary.
type ContextGeneratorPort = Pick<ContextGenerator, "enrich"> &
  Partial<Pick<ContextGenerator, "summarizeDocument">>;
type EmbeddingProviderPort = Pick<EmbeddingProvider, "embedTexts">;
type ContextGeneratorFactory = (
  settings: IngestionRuntimeSettings,
  logger: RuntimeLogger,
) => ContextGeneratorPort;
type EmbeddingProviderFactory = (
  settings: IngestionRuntimeSettings,
  logger: RuntimeLogger,
) => EmbeddingProviderPort;
type ResolveJobSecrets = (document: DocumentRecord) => Promise<{
  openAiApiKey: string | null;
  anthropicApiKey: string | null;
}>;

export class IngestionPipeline {
  private readonly settings: IngestionRuntimeSettings;
  private readonly repository: IngestionRuntimeRepository;
  private readonly logger: RuntimeLogger;
  private readonly extractPagesFn: ExtractPagesFn;
  /**
   * Extracted text of the document being processed, kept for the life of this
   * pipeline — which is exactly one run. A document too large for one batch
   * re-enters `processJob` once per batch, and every re-entry used to
   * re-download and re-parse the whole PDF just to rebuild this string. On a
   * 313-page book that measured ~0.7s of each ~11s batch, and it was paid 92
   * times: ~130 MB re-downloaded and 313 pages re-parsed per ingestion.
   */
  private cachedDocumentText: {
    documentId: string;
    text: string;
  } | null = null;
  /**
   * Chunk candidates for the job in flight.
   *
   * `loadJobProgress` reads the whole `chunk_candidates` JSONB, and it ran
   * once per batch: ~700 KB re-fetched 93 times for a 313-page book, growing
   * linearly with the document. The blob is written once at the end of
   * extraction and never changes, and this run holds the job's lock, so
   * re-reading it says nothing new. Only the processed counter advances, and
   * that is read fresh every batch.
   */
  private cachedCandidates: {
    jobId: string;
    candidates: ChunkCandidate[];
  } | null = null;
  private readonly contextGeneratorFactory: ContextGeneratorFactory;
  private readonly embeddingProviderFactory: EmbeddingProviderFactory;
  private readonly resolveJobSecrets: ResolveJobSecrets;

  constructor(input: {
    settings: IngestionRuntimeSettings;
    repository: IngestionRuntimeRepository;
    logger?: RuntimeLogger;
    extractPagesFn?: ExtractPagesFn;
    contextGenerator?: ContextGeneratorPort;
    embeddingProvider?: EmbeddingProviderPort;
    resolveJobSecrets?: ResolveJobSecrets;
  }) {
    this.settings = input.settings;
    this.repository = input.repository;
    this.logger = input.logger ?? console;
    this.extractPagesFn = input.extractPagesFn ?? extractPages;
    this.contextGeneratorFactory = input.contextGenerator
      ? () => input.contextGenerator as ContextGeneratorPort
      : (settings, logger) => new ContextGenerator(settings, logger);
    this.embeddingProviderFactory = input.embeddingProvider
      ? () => input.embeddingProvider as EmbeddingProviderPort
      : (settings, logger) => new EmbeddingProvider(settings, logger);
    this.resolveJobSecrets =
      input.resolveJobSecrets ??
      (async (document) => {
        if (!document.userId) {
          return {
            openAiApiKey: this.settings.openAiApiKey,
            anthropicApiKey: this.settings.anthropicApiKey,
          };
        }
        const { resolveDocumentProviderSecrets } =
          await import("@/lib/providers/document-provider-secrets");
        return resolveDocumentProviderSecrets({
          userId: document.userId,
          fallbackOpenAiApiKey: this.settings.openAiApiKey,
          fallbackAnthropicApiKey: this.settings.anthropicApiKey,
        });
      });
  }

  /**
   * One Langfuse trace per job. A job is the natural unit of work here: it
   * extracts, chunks, contextualises, and embeds a single document, and it can
   * resume across invocations — so `resumed` and the chunk counts are what
   * make a partial run readable rather than looking like a failure.
   */
  async processJob(job: IngestionJob): Promise<ProcessJobResult> {
    return propagateAttributes(
      {
        traceName: "ingest-document",
        sessionId: job.documentId,
        tags: ["ingestion"],
        metadata: { jobId: job.id, documentId: job.documentId },
      },
      async () =>
        startActiveObservation(
          "ingest-document",
          async (observation) => {
            observation.update({
              input: {
                documentId: job.documentId,
                resumed: Boolean(job.currentStage),
                stage: job.currentStage ?? null,
              },
            });

            const result = await this.processJobUntraced(job);

            observation.update({
              output: result,
              metadata: { status: result.status },
            });

            return result;
          },
          { asType: "chain" },
        ),
    );
  }

  private async processJobUntraced(
    job: IngestionJob,
  ): Promise<ProcessJobResult> {
    const pipelineStart = Date.now();
    const elapsed = () =>
      `${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`;
    const setStage = async (stage: string) => {
      if (job.currentStage === stage) {
        return;
      }
      await this.repository.updateJobStage(job.id, stage);
      job.currentStage = stage;
    };

    const document = await this.repository.getDocument(job.documentId);
    const jobSecrets = await this.resolveJobSecrets(document);
    const jobSettings: IngestionRuntimeSettings = {
      ...this.settings,
      openAiApiKey: jobSecrets.openAiApiKey,
      anthropicApiKey: jobSecrets.anthropicApiKey,
    };
    const contextGenerator = this.contextGeneratorFactory(
      jobSettings,
      this.logger,
    );
    const embeddingProvider = this.embeddingProviderFactory(
      jobSettings,
      this.logger,
    );

    // Load incremental state
    const cachedCandidates =
      this.cachedCandidates?.jobId === job.id
        ? this.cachedCandidates.candidates
        : null;
    let progress: JobProgress = await this.repository.loadJobProgress(
      job.id,
      cachedCandidates === null,
    );
    if (!progress.candidates && cachedCandidates) {
      progress = { ...progress, candidates: cachedCandidates };
    }

    /*
     * Full document text, fed to the context generator so each chunk is
     * situated against the whole document rather than a summary of its first
     * page. Populated during extraction on the first run; a resumed run
     * re-derives it below rather than checkpointing it, which would put fifty
     * pages of text into the `chunk_candidates` JSONB blob on every job.
     */
    let documentText: string | null = null;

    // Phase 1: Extract (first invocation only — no candidates saved yet)
    if (!progress.candidates) {
      await setStage("extracting");
      this.logger.info("pipeline_step", {
        step: "extraction_start",
        elapsed: elapsed(),
        jobId: job.id,
        documentId: document.id,
      });

      const pdfBytes = await this.repository.downloadDocument(
        document.storagePath,
      );
      this.logger.info("pipeline_step", {
        step: "pdf_downloaded",
        elapsed: elapsed(),
        bytes: pdfBytes.length,
      });

      // OCR needs the job's OpenAI key: a document without one keeps the
      // text-layer-only behaviour and fails loudly below if it is scanned.
      const ocr =
        this.settings.ocrFallbackEnabled && jobSettings.openAiApiKey
          ? {
              transcribePage: createOpenAiTranscriber({
                apiKey: jobSettings.openAiApiKey,
                model: this.settings.ocrModel,
              }),
            }
          : null;
      const pages = await this.extractPagesFn(pdfBytes, ocr, this.logger);
      // pdfjs and OCR can mix within one document (a scanned appendix in a
      // native PDF); the byte-scrape fallback is always the whole document,
      // collapsed to a single page.
      const extractionMethod = pages[0]?.method;
      const ocrPageCount = pages.filter((page) => page.method === "ocr").length;
      this.logger.info("pipeline_step", {
        step: "pages_extracted",
        elapsed: elapsed(),
        pageCount: pages.length,
        extractionMethod: extractionMethod ?? null,
        ocrPageCount,
      });

      /*
       * The byte scrape is a last resort that collapses every page onto page
       * 1. Its output used to be ingested and the document marked `ready`, so
       * it answered queries with citations that all claimed page 1 and text
       * pulled straight from PDF operators — wrong in a way no error surfaced
       * and no reader could detect. A document that cannot be parsed properly
       * is a failure, not a degraded success.
       */
      if (extractionMethod === "byte_scrape") {
        throw new Error(
          "PDF text extraction failed: the file could not be parsed and " +
            "OCR found no text on its pages. Page numbers and structure " +
            "cannot be recovered, so it was not ingested.",
        );
      }

      const furniture = stripPageFurniture(pages);
      if (furniture.report.linesRemoved > 0) {
        this.logger.info("pipeline_step", {
          step: "page_furniture_stripped",
          elapsed: elapsed(),
          linesRemoved: furniture.report.linesRemoved,
          folioOffset: furniture.report.folioOffset,
          runningHeadPages: furniture.runningHeads.size,
          patterns: furniture.report.patterns,
        });
      }
      const contentPages = furniture.pages;

      documentText = contentPages.map((page) => page.text).join("\n\n");
      this.cachedDocumentText = { documentId: document.id, text: documentText };

      // One document-level summary, generated once and persisted: it is the
      // fallback whenever the document is outside the cacheable size window.
      // Failure to summarise must not fail ingestion.
      if (!document.summary && contextGenerator.summarizeDocument) {
        try {
          const summary = await contextGenerator.summarizeDocument({
            title: document.title,
            text: documentText,
          });
          if (summary) {
            await this.repository.setDocumentSummary(document.id, summary);
            document.summary = summary;
            this.logger.info("pipeline_step", {
              step: "document_summary_generated",
              elapsed: elapsed(),
              summaryChars: summary.length,
            });
          }
        } catch (error) {
          this.logger.warn("document_summary_generation_failed", {
            documentId: document.id,
            message: error instanceof Error ? error.message : "unknown_error",
          });
        }
      }

      await setStage("chunking");
      // Document-level so a heading carries to its continuation on the next
      // page instead of restarting at `Page N`.
      const sections = splitPagesIntoSections(
        contentPages,
        furniture.runningHeads,
      );

      if (sections.length === 0) {
        throw new Error("No extractable text found in document");
      }

      const sectionLanguages = assignSectionLanguages(
        sections,
        document.language,
      );
      const sectionsWithLanguage = sections.map((section, index) => ({
        ...section,
        language: sectionLanguages[index]!,
      }));

      let chunkCandidates: ChunkCandidate[] = [];
      for (const group of groupSectionsByLanguage(sectionsWithLanguage)) {
        const sectionChunks = chunkSections({
          sections: group.sections,
          language: group.language,
          targetTokens: this.settings.chunkTargetTokens,
          overlapTokens: this.settings.chunkOverlapTokens,
          minChars: this.settings.chunkMinChars,
        });
        chunkCandidates = chunkCandidates.concat(sectionChunks);
      }

      chunkCandidates = reindexChunks(chunkCandidates);

      if (chunkCandidates.length === 0) {
        const relaxedFallbackChunk = buildRelaxedDocumentFallbackChunk(
          sections,
          document.language,
        );
        if (!relaxedFallbackChunk) {
          throw new Error("No chunks generated from extracted sections");
        }

        chunkCandidates = [relaxedFallbackChunk];
        this.logger.warn("ingestion_chunk_generation_relaxed_fallback", {
          jobId: job.id,
          documentId: document.id,
          fallbackChars: relaxedFallbackChunk.content.length,
        });
      }

      // Stamp provenance once, after every candidate path (regular, merged,
      // relaxed fallback) has produced its final content. Survives the
      // chunk_candidates JSONB checkpoint.
      chunkCandidates = chunkCandidates.map((candidate) => ({
        ...candidate,
        extractionMethod,
        tokenCount: countTokens(candidate.content),
      }));

      await this.repository.saveChunkCandidates(
        job.id,
        chunkCandidates,
        chunkCandidates.length,
      );
      this.logger.info("pipeline_step", {
        step: "candidates_saved",
        elapsed: elapsed(),
        total: chunkCandidates.length,
      });

      progress = {
        candidates: chunkCandidates,
        chunksProcessed: 0,
        chunksTotal: chunkCandidates.length,
        currentStage: "chunked",
      };
      this.cachedCandidates = { jobId: job.id, candidates: chunkCandidates };
      job.currentStage = "chunked";
    }

    // Phase 2: Process next batch of chunks
    const { candidates, chunksProcessed, chunksTotal } = progress;
    if (!candidates || candidates.length === 0) {
      throw new Error("No chunk candidates found for job");
    }

    // Early return if already fully processed (idempotent re-call)
    if (chunksProcessed >= chunksTotal) {
      return { status: "completed", chunksProcessed, chunksTotal };
    }

    // Delete existing chunks on first batch (fresh start or retry from 0)
    if (chunksProcessed === 0) {
      await setStage("clearing_chunks");
      await this.repository.replaceDocumentChunks(document.id, []);
      this.logger.info("pipeline_step", {
        step: "existing_chunks_cleared",
        elapsed: elapsed(),
        documentId: document.id,
      });
    }

    const batchStart = chunksProcessed;
    const batchEnd = Math.min(
      batchStart + this.settings.chunksPerRun,
      chunksTotal,
    );
    const batch = candidates.slice(batchStart, batchEnd);

    this.logger.info("pipeline_step", {
      step: "batch_start",
      elapsed: elapsed(),
      batchStart,
      batchEnd,
      total: chunksTotal,
    });

    // Enrich batch with context, situating each chunk within the document.
    await setStage("contextualizing");

    if (documentText === null) {
      documentText =
        this.cachedDocumentText?.documentId === document.id
          ? this.cachedDocumentText.text
          : null;
    }

    if (documentText === null) {
      /*
       * A resumed run whose extraction happened in an earlier invocation, so
       * there is nothing cached in this process. Re-deriving the text costs a
       * download and a parse — seconds, no LLM spend — and keeps the
       * whole-document context available across the runs a large document
       * spans. Every later batch of this run reads the cache instead.
       * Failure falls back to the summary path.
       *
       * OCR is deliberately NOT repeated here: a scanned document would
       * otherwise be transcribed again on every resumed batch. Its text is
       * rebuilt from the saved chunk candidates instead, which carry the
       * OCR output already (overlap windows duplicated, which the context
       * prompt tolerates).
       */
      try {
        const pdfBytes = await this.repository.downloadDocument(
          document.storagePath,
        );
        const pages = await this.extractPagesFn(pdfBytes, null, this.logger);
        const extractedText = pages.map((page) => page.text).join("\n\n");
        documentText =
          extractedText.trim().length > 0
            ? extractedText
            : (progress.candidates ?? [])
                .map((chunk) => chunk.content)
                .join("\n\n");
        this.cachedDocumentText = {
          documentId: document.id,
          text: documentText,
        };
        this.logger.info("pipeline_step", {
          step: "document_text_reextracted",
          elapsed: elapsed(),
          chars: documentText.length,
        });
      } catch (error) {
        this.logger.warn("document_text_reextraction_failed", {
          documentId: document.id,
          message: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    const batchWithContext = await contextGenerator.enrich(batch, {
      title: document.title,
      summary: document.summary,
      text: documentText,
    });
    this.logger.info("pipeline_step", {
      step: "batch_context_enriched",
      elapsed: elapsed(),
      count: batchWithContext.length,
    });

    // Generate embeddings for batch
    await setStage("embedding");
    /*
     * Document title and section breadcrumb lead the embedded string.
     *
     * They previously reached only `section_title`, which feeds the keyword
     * tsvector but not the dense branch — so a query phrased in a heading's own
     * words had to hope the generated context happened to echo it. The order is
     * fixed rather than conditional so the same chunk always embeds to the same
     * string.
     */
    const embeddingInputs = batchWithContext.map((item) =>
      [
        document.title ?? "",
        item.sectionTitle,
        item.context,
        "",
        item.content,
      ].join("\n"),
    );
    const embeddings = await embeddingProvider.embedTexts(embeddingInputs);
    this.logger.info("pipeline_step", {
      step: "batch_embeddings_generated",
      elapsed: elapsed(),
      count: embeddings.length,
    });

    if (embeddings.length !== batchWithContext.length) {
      throw new Error("Embedding response size mismatch");
    }

    const preparedChunks: PreparedChunkRecord[] = batchWithContext.map(
      (chunk, index) => {
        const embedding = embeddings[index];
        if (!embedding || embedding.length !== this.settings.embeddingDim) {
          throw new Error(
            `Embedding dimension mismatch for chunk ${chunk.chunkIndex}: expected ${this.settings.embeddingDim}, got ${embedding?.length ?? 0}`,
          );
        }

        return {
          documentId: document.id,
          chunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          sectionTitle: chunk.sectionTitle,
          content: chunk.content,
          context: chunk.context,
          language: chunk.language,
          embedding,
          extractionMethod: chunk.extractionMethod ?? null,
          embeddingModel: `${this.settings.embeddingModel}@${this.settings.embeddingDimensions ?? this.settings.embeddingDim}`,
          tokenCount: chunk.tokenCount ?? null,
        };
      },
    );

    // Insert batch (append)
    await setStage("storing");
    await this.repository.insertChunkBatch(document.id, preparedChunks);
    this.logger.info("pipeline_step", {
      step: "batch_stored",
      elapsed: elapsed(),
      count: preparedChunks.length,
    });

    // Update progress
    const newChunksProcessed = batchEnd;
    await this.repository.updateJobProgress(job.id, newChunksProcessed);

    // Check if all chunks are processed
    if (newChunksProcessed >= chunksTotal) {
      const selectedLanguage = determineDocumentLanguage(
        candidates.map((item) => item.language),
        document.language,
      );

      try {
        await setStage("finalizing");
        await this.repository.invalidateRetrievalCache();
      } catch (error) {
        this.logger.warn("retrieval_cache_invalidation_failed", {
          jobId: job.id,
          documentId: document.id,
          message: error instanceof Error ? error.message : "unknown_error",
        });
      }

      this.logger.info("ingestion_job_completed", {
        jobId: job.id,
        documentId: document.id,
        chunks: chunksTotal,
        language: selectedLanguage,
        totalSeconds: ((Date.now() - pipelineStart) / 1000).toFixed(1),
      });

      return {
        status: "completed",
        chunksProcessed: newChunksProcessed,
        chunksTotal,
        documentLanguage: selectedLanguage,
      };
    }

    this.logger.info("pipeline_step", {
      step: "batch_partial",
      elapsed: elapsed(),
      chunksProcessed: newChunksProcessed,
      chunksTotal,
      remaining: chunksTotal - newChunksProcessed,
    });

    return {
      status: "partial",
      chunksProcessed: newChunksProcessed,
      chunksTotal,
    };
  }
}
