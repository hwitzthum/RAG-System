import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  flushTracing,
  getLangfuseSpanProcessor,
} from "@/lib/observability/langfuse";

/**
 * OpenTelemetry bootstrap for standalone Node processes — the ingestion worker
 * and the evaluation scripts.
 *
 * Kept separate from lib/observability/langfuse.ts, and never imported from
 * anything the Next.js bundler can reach: `@opentelemetry/sdk-node` pulls in
 * gRPC/OTLP exporters that Next.js cannot bundle. The Next.js server registers
 * the same span processor through @vercel/otel in instrumentation.ts instead.
 */

let sdk: NodeSDK | null = null;

/** Idempotent; a no-op when Langfuse credentials are not configured. */
export function startNodeTracing(): void {
  if (sdk) {
    return;
  }

  const spanProcessor = getLangfuseSpanProcessor();
  if (!spanProcessor) {
    return;
  }

  sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
}

/**
 * Flush and tear down. Long-running scripts exit as soon as their work is
 * done, which would otherwise discard everything still buffered.
 */
export async function stopNodeTracing(): Promise<void> {
  await flushTracing();
  try {
    await sdk?.shutdown();
  } catch (error) {
    console.warn(
      "langfuse_shutdown_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
