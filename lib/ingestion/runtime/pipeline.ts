import { chunkSections, splitIntoSections } from "@/lib/ingestion/runtime/chunking";
import { ContextGenerator } from "@/lib/ingestion/runtime/context-generator";
import { EmbeddingProvider } from "@/lib/ingestion/runtime/embedding-provider";
import { extractPages } from "@/lib/ingestion/runtime/pdf-extractor";
import type {
  ChunkCandidate,
  IngestionJob,
  IngestionRuntimeSettings,
  JobProgress,
  PreparedChunkRecord,
  ProcessJobResult,
  RuntimeLogger,
} from "@/lib/ingestion/runtime/types";
import type { IngestionRuntimeRepository } from "@/lib/ingestion/runtime/repository";
import type { SupportedLanguage } from "@/lib/supabase/database.types";

function detectLanguage(text: string, languageHint: SupportedLanguage | null): SupportedLanguage {
  if (languageHint) {
    return languageHint;
  }

  const lowered = text.toLowerCase();
  if (!lowered) {
    return "EN";
  }

  const keywordMap: Record<SupportedLanguage, string[]> = {
    DE: [" und ", " der ", " die ", " das ", " fuer ", " für "],
    FR: [" le ", " la ", " les ", " des ", " pour "],
    IT: [" il ", " lo ", " gli ", " per ", " con "],
    ES: [" el ", " la ", " los ", " para ", " con "],
    EN: [" the ", " and ", " for ", " with ", " from "],
  };

  let bestLanguage: SupportedLanguage = "EN";
  let bestScore = -1;
  const padded = ` ${lowered} `;

  for (const language of Object.keys(keywordMap) as SupportedLanguage[]) {
    const score = keywordMap[language].reduce((sum, keyword) => sum + padded.split(keyword).length - 1, 0);
    if (score > bestScore) {
      bestScore = score;
      bestLanguage = language;
    }
  }

  return bestLanguage;
}

function determineDocumentLanguage(chunkLanguages: SupportedLanguage[], fallback: SupportedLanguage | null): SupportedLanguage {
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
    language: detectLanguage(combinedContent, languageHint),
  };
}

type ExtractPagesFn = typeof extractPages;
type ContextGeneratorPort = Pick<ContextGenerator, "enrich">;
type EmbeddingProviderPort = Pick<EmbeddingProvider, "embedTexts">;

export class IngestionPipeline {
  private readonly settings: IngestionRuntimeSettings;
  private readonly repository: IngestionRuntimeRepository;
  private readonly logger: RuntimeLogger;
  private readonly extractPagesFn: ExtractPagesFn;
  private readonly contextGenerator: ContextGeneratorPort;
  private readonly embeddingProvider: EmbeddingProviderPort;

  constructor(input: {
    settings: IngestionRuntimeSettings;
    repository: IngestionRuntimeRepository;
    logger?: RuntimeLogger;
    extractPagesFn?: ExtractPagesFn;
    contextGenerator?: ContextGeneratorPort;
    embeddingProvider?: EmbeddingProviderPort;
  }) {
    this.settings = input.settings;
    this.repository = input.repository;
    this.logger = input.logger ?? console;
    this.extractPagesFn = input.extractPagesFn ?? extractPages;
    this.contextGenerator = input.contextGenerator ?? new ContextGenerator(input.settings, this.logger);
    this.embeddingProvider = input.embeddingProvider ?? new EmbeddingProvider(input.settings, this.logger);
  }

  async processJob(job: IngestionJob): Promise<ProcessJobResult> {
    const pipelineStart = Date.now();
    const elapsed = () => `${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`;
    const setStage = async (stage: string) => {
      if (job.currentStage === stage) {
        return;
      }
      await this.repository.updateJobStage(job.id, stage);
      job.currentStage = stage;
    };

    const document = await this.repository.getDocument(job.documentId);

    // Load incremental state
    let progress: JobProgress = await this.repository.loadJobProgress(job.id);

    // Phase 1: Extract (first invocation only — no candidates saved yet)
    if (!progress.candidates) {
      await setStage("extracting");
      this.logger.info("pipeline_step", { step: "extraction_start", elapsed: elapsed(), jobId: job.id, documentId: document.id });

      const pdfBytes = await this.repository.downloadDocument(document.storagePath);
      this.logger.info("pipeline_step", { step: "pdf_downloaded", elapsed: elapsed(), bytes: pdfBytes.length });

      const pages = await this.extractPagesFn(pdfBytes, this.settings.ocrFallbackEnabled, this.logger);
      this.logger.info("pipeline_step", { step: "pages_extracted", elapsed: elapsed(), pageCount: pages.length });

      await setStage("chunking");
      const sections = [];
      for (const page of pages) {
        if (page.text.trim()) {
          sections.push(...splitIntoSections(page));
        }
      }

      if (sections.length === 0) {
        throw new Error("No extractable text found in document");
      }

      let chunkCandidates: ChunkCandidate[] = [];
      for (const section of sections) {
        const language = detectLanguage(section.text, document.language);
        const sectionChunks = chunkSections({
          sections: [section],
          language,
          targetTokens: this.settings.chunkTargetTokens,
          overlapTokens: this.settings.chunkOverlapTokens,
          minChars: this.settings.chunkMinChars,
        });
        chunkCandidates = chunkCandidates.concat(sectionChunks);
      }

      chunkCandidates = reindexChunks(chunkCandidates);

      if (chunkCandidates.length === 0) {
        const relaxedFallbackChunk = buildRelaxedDocumentFallbackChunk(sections, document.language);
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

      await this.repository.saveChunkCandidates(job.id, chunkCandidates, chunkCandidates.length);
      this.logger.info("pipeline_step", { step: "candidates_saved", elapsed: elapsed(), total: chunkCandidates.length });

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
      this.logger.info("pipeline_step", { step: "existing_chunks_cleared", elapsed: elapsed(), documentId: document.id });
    }

    const batchStart = chunksProcessed;
    const batchEnd = Math.min(batchStart + this.settings.chunksPerRun, chunksTotal);
    const batch = candidates.slice(batchStart, batchEnd);

    this.logger.info("pipeline_step", { step: "batch_start", elapsed: elapsed(), batchStart, batchEnd, total: chunksTotal });

    // Enrich batch with context
    await setStage("contextualizing");
    const batchWithContext = await this.contextGenerator.enrich(batch);
    this.logger.info("pipeline_step", { step: "batch_context_enriched", elapsed: elapsed(), count: batchWithContext.length });

    // Generate embeddings for batch
    await setStage("embedding");
    const embeddingInputs = batchWithContext.map((item) => `${item.context}\n\n${item.content}`);
    const embeddings = await this.embeddingProvider.embedTexts(embeddingInputs);
    this.logger.info("pipeline_step", { step: "batch_embeddings_generated", elapsed: elapsed(), count: embeddings.length });

    if (embeddings.length !== batchWithContext.length) {
      throw new Error("Embedding response size mismatch");
    }

    const preparedChunks: PreparedChunkRecord[] = batchWithContext.map((chunk, index) => {
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
      };
    });

    // Insert batch (append)
    await setStage("storing");
    await this.repository.insertChunkBatch(document.id, preparedChunks);
    this.logger.info("pipeline_step", { step: "batch_stored", elapsed: elapsed(), count: preparedChunks.length });

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

    return { status: "partial", chunksProcessed: newChunksProcessed, chunksTotal };
  }
}
