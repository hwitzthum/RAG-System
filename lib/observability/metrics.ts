import { env } from "@/lib/config/env";

type MetricEvent = {
  metricName: string;
  value: number;
  unit?: string;
  tags?: Record<string, string | number | boolean | null>;
};

const METRICS_ENDPOINT = "/api/internal/observability/metrics";

export async function emitMetric(event: MetricEvent): Promise<void> {
  if (!env.OBSERVABILITY_METRICS_SINK_AUTH_TOKEN) {
    return;
  }

  // Use the app's own origin for the internal metrics endpoint.
  // In production, VERCEL_URL or similar would be available; fall back to localhost.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://localhost:${process.env.PORT ?? "3001"}`;

  try {
    const url = `${baseUrl}${METRICS_ENDPOINT}`;

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OBSERVABILITY_METRICS_SINK_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        eventType: "metric",
        metricName: event.metricName,
        value: event.value,
        unit: event.unit,
        tags: event.tags,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget: don't block the caller if metrics fail.
  }
}

export function emitQueryLatency(latencyMs: number, tags?: Record<string, string | number | boolean | null>): void {
  void emitMetric({
    metricName: "query.latency_ms",
    value: latencyMs,
    unit: "ms",
    tags,
  });
}

export function emitCacheHit(hit: boolean, tags?: Record<string, string | number | boolean | null>): void {
  void emitMetric({
    metricName: "query.cache_hit",
    value: hit ? 1 : 0,
    unit: "bool",
    tags,
  });
}

export function emitUploadCount(tags?: Record<string, string | number | boolean | null>): void {
  void emitMetric({
    metricName: "upload.count",
    value: 1,
    unit: "count",
    tags,
  });
}
