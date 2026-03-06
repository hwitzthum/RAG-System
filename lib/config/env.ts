import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default("RAG System"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_DEV_INSECURE_BYPASS: z.coerce.boolean().default(false),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BYOK_VAULT_KEY: z.string().min(1).optional(),
  OPENAI_BYOK_VAULT_KEY_VERSION: z.coerce.number().int().positive().default(1),
  RAG_QUERY_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  RAG_RETRIEVAL_VERSION: z.coerce.number().int().positive().default(1),
  RAG_RRF_K: z.coerce.number().int().positive().default(60),
  RAG_RERANK_POOL_SIZE: z.coerce.number().int().positive().default(20),
  RAG_LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  RAG_LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(700),
  RAG_MIN_EVIDENCE_CHUNKS: z.coerce.number().int().positive().default(1),
  RAG_MIN_RERANK_SCORE: z.coerce.number().nonnegative().default(0.1),
  RAG_DEFAULT_TOP_K: z.coerce.number().int().positive().default(8),
  RAG_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  RAG_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),
  RAG_STORAGE_BUCKET: z.string().min(1).default("documents"),
});

const parsed = envSchema.safeParse({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
  AUTH_JWKS_URL: process.env.AUTH_JWKS_URL,
  AUTH_DEV_INSECURE_BYPASS: process.env.AUTH_DEV_INSECURE_BYPASS,
  AUTH_RATE_LIMIT_WINDOW_SECONDS: process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
  AUTH_RATE_LIMIT_MAX_REQUESTS: process.env.AUTH_RATE_LIMIT_MAX_REQUESTS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BYOK_VAULT_KEY: process.env.OPENAI_BYOK_VAULT_KEY,
  OPENAI_BYOK_VAULT_KEY_VERSION: process.env.OPENAI_BYOK_VAULT_KEY_VERSION,
  RAG_QUERY_EMBEDDING_MODEL: process.env.RAG_QUERY_EMBEDDING_MODEL,
  RAG_RETRIEVAL_VERSION: process.env.RAG_RETRIEVAL_VERSION,
  RAG_RRF_K: process.env.RAG_RRF_K,
  RAG_RERANK_POOL_SIZE: process.env.RAG_RERANK_POOL_SIZE,
  RAG_LLM_MODEL: process.env.RAG_LLM_MODEL,
  RAG_LLM_MAX_OUTPUT_TOKENS: process.env.RAG_LLM_MAX_OUTPUT_TOKENS,
  RAG_MIN_EVIDENCE_CHUNKS: process.env.RAG_MIN_EVIDENCE_CHUNKS,
  RAG_MIN_RERANK_SCORE: process.env.RAG_MIN_RERANK_SCORE,
  RAG_DEFAULT_TOP_K: process.env.RAG_DEFAULT_TOP_K,
  RAG_CACHE_TTL_SECONDS: process.env.RAG_CACHE_TTL_SECONDS,
  RAG_MAX_UPLOAD_BYTES: process.env.RAG_MAX_UPLOAD_BYTES,
  RAG_STORAGE_BUCKET: process.env.RAG_STORAGE_BUCKET,
});

if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  throw new Error("Environment variable validation failed");
}

const config = {
  ...parsed.data,
  AUTH_JWKS_URL: parsed.data.AUTH_JWKS_URL ?? `${parsed.data.SUPABASE_URL}/auth/v1/keys`,
};

if (!config.SUPABASE_JWT_SECRET && !config.AUTH_JWKS_URL) {
  throw new Error("Either SUPABASE_JWT_SECRET or AUTH_JWKS_URL must be configured");
}

if (config.NODE_ENV === "production" && config.AUTH_DEV_INSECURE_BYPASS) {
  throw new Error("AUTH_DEV_INSECURE_BYPASS cannot be enabled in production");
}

if (config.OPENAI_BYOK_VAULT_KEY && Buffer.from(config.OPENAI_BYOK_VAULT_KEY, "base64").length !== 32) {
  throw new Error("OPENAI_BYOK_VAULT_KEY must be base64-encoded and decode to 32 bytes");
}

if (config.NODE_ENV === "production" && !config.OPENAI_BYOK_VAULT_KEY) {
  throw new Error("OPENAI_BYOK_VAULT_KEY must be configured in production");
}

export const env = config;
