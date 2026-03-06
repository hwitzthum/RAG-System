import { NextResponse } from "next/server";
import { env } from "@/lib/config/env";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "rag-system-web",
    nodeEnv: env.NODE_ENV,
    defaultTopK: env.RAG_DEFAULT_TOP_K,
    cacheTtlSeconds: env.RAG_CACHE_TTL_SECONDS,
    maxUploadBytes: env.RAG_MAX_UPLOAD_BYTES,
    storageBucket: env.RAG_STORAGE_BUCKET,
    authRateLimit: {
      maxRequests: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    },
  });
}
