/**
 * Next.js instrumentation hook — runs once per server process, before any
 * route handler.
 *
 * Registers via @vercel/otel rather than the OpenTelemetry Node SDK: the Node
 * SDK is not bundler-safe inside Next.js (it reaches gRPC exporters through
 * optional requires). @vercel/otel v2+ is built on the same OTel JS SDK v2
 * that @langfuse/tracing targets, so the processor is identical either way.
 *
 * The processor itself lives in lib/observability/langfuse.ts so that route
 * handlers importing it for `flushTracing()` share this module instance.
 * Registering it here and flushing "it" from a route would flush a second,
 * empty processor if the bundler split them.
 */
export async function register(): Promise<void> {
  // The span processor depends on Node APIs; the edge runtime also evaluates
  // this file.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const [{ registerOTel }, { getLangfuseSpanProcessor }] = await Promise.all([
    import("@vercel/otel"),
    import("@/lib/observability/langfuse"),
  ]);

  const spanProcessor = getLangfuseSpanProcessor();
  if (!spanProcessor) {
    return;
  }

  registerOTel({
    serviceName: "rag-system",
    spanProcessors: [spanProcessor],
  });
}
