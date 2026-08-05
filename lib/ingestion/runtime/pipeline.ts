import {
  chunkSections,
  countTokens,
  splitPagesIntoSections,
} from "@/lib/ingestion/runtime/chunking";
import { ContextGenerator } from "@/lib/ingestion/runtime/context-generator";
import { EmbeddingProvider } from "@/lib/ingestion/runtime/embedding-provider";
import { extractPages } from "@/lib/ingestion/runtime/pdf-extractor";
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

  async processJob(job: IngestionJob): Promise<ProcessJobResult> {
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
    let progress: JobProgress = await this.repository.loadJobProgress(job.id);

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

      const pages = await this.extractPagesFn(
        pdfBytes,
        this.settings.ocrFallbackEnabled,
        this.logger,
      );
      // The extractor uses one method for the whole document (pdfjs, or the
      // byte-scrape fallback which collapses everything to a single page).
      const extractionMethod = pages[0]?.method;
      this.logger.info("pipeline_step", {
        step: "pages_extracted",
        elapsed: elapsed(),
        pageCount: pages.length,
        extractionMethod: extractionMethod ?? null,
      });

      documentText = pages.map((page) => page.text).join("\n\n");

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
      const sections = splitPagesIntoSections(pages);

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
      /*
       * A resumed run: extraction happened on an earlier invocation. Re-deriving
       * the text costs a download and a parse — seconds, no LLM spend — and
       * keeps the whole-document context available across the runs a large
       * document spans. Failure falls back to the summary path.
       */
      try {
        const pdfBytes = await this.repository.downloadDocument(
          document.storagePath,
        );
        const pages = await this.extractPagesFn(
          pdfBytes,
          this.settings.ocrFallbackEnabled,
          this.logger,
        );
        documentText = pages.map((page) => page.text).join("\n\n");
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
