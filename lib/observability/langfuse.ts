import { LangfuseSpanProcessor } from "@langfuse/otel";
import { maskForTracing } from "@/lib/security/output-filter";

/**
 * Langfuse span processor and flush helpers.
 *
 * Deliberately free of any `@opentelemetry/sdk-node` import: that package
 * reaches OTLP/gRPC exporters through optional requires, and pulling it into a
 * module the Next.js bundler can see makes the build fail resolving Node
 * built-ins. The OTel provider is registered per runtime instead —
 * instrumentation.ts uses @vercel/otel for the Next.js server, and
 * lib/observability/langfuse-node.ts uses the Node SDK for standalone scripts.
 * Both share the one processor created here.
 *
 * Reads process.env directly rather than lib/config/env.ts because it loads at
 * server boot and inside scripts, and must not drag the full env schema (which
 * throws on a missing required variable) into either path. Tracing is strictly
 * optional: with no credentials configured every export here is inert, so
 * builds, tests, and contributors without Langfuse keys are unaffected.
 */

function hasCredentials(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/**
 * Keeps local and preview traffic out of the production Langfuse environment,
 * so production dashboards and evaluators are never polluted by test traces.
 */
function resolveEnvironment(): string {
  const explicit = process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim();
  if (explicit) {
    return explicit;
  }

  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") {
    return "production";
  }
  if (vercelEnv === "preview") {
    return "staging";
  }

  return process.env.NODE_ENV === "production" ? "production" : "development";
}

let spanProcessor: LangfuseSpanProcessor | null = null;

/** Null when no credentials are configured, which disables tracing entirely. */
export function getLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  if (!hasCredentials()) {
    return null;
  }

  if (!spanProcessor) {
    spanProcessor = new LangfuseSpanProcessor({
      environment: resolveEnvironment(),
      release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
      // Applied to input, output, and metadata of every observation. A throw
      // in here would drop the span, so failures degrade to a placeholder
      // rather than propagating.
      mask: ({ data }) => {
        try {
          return maskForTracing(data);
        } catch {
          return "[MASKING_FAILED]";
        }
      },
    });
  }

  return spanProcessor;
}

/**
 * Flushes buffered spans. Required before a serverless function returns — the
 * runtime freezes the sandbox once the response is sent, and anything still
 * buffered is lost. Never throws: losing a trace must not fail a request.
 */
export async function flushTracing(): Promise<void> {
  try {
    await spanProcessor?.forceFlush();
  } catch (error) {
    console.warn(
      "langfuse_flush_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
