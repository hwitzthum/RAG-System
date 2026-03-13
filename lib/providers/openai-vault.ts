import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/config/env";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

const OPENAI_KEY_PREFIX = "sk-";
const OPENAI_KEY_MIN_LENGTH = 20;
const OPENAI_KEY_MAX_LENGTH = 512;
const PRINTABLE_ASCII_NO_SPACES_PATTERN = /^[\x21-\x7E]+$/;
const AES_ALGORITHM = "aes-256-gcm";
const AES_IV_BYTES = 12;
const AES_KEY_BYTES = 32;

type UserOpenAiKeyRow = Database["public"]["Tables"]["user_openai_keys"]["Row"];

type EncryptedPayload = {
  encryptedKey: string;
  iv: string;
  authTag: string;
};

export type OpenAiByokStatus = {
  vaultEnabled: boolean;
  configured: boolean;
  keyLast4: string | null;
  updatedAt: string | null;
};

let cachedVaultKey: Buffer | null = null;

function isMissingVaultTableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("user_openai_keys") &&
    (normalized.includes("does not exist") || normalized.includes("could not find the table"))
  );
}

function decodeVaultKey(): Buffer {
  if (cachedVaultKey) {
    return cachedVaultKey;
  }

  if (!env.OPENAI_BYOK_VAULT_KEY) {
    throw new Error("OPENAI_BYOK_VAULT_KEY is not configured");
  }

  const decoded = Buffer.from(env.OPENAI_BYOK_VAULT_KEY, "base64");
  if (decoded.length !== AES_KEY_BYTES) {
    throw new Error("OPENAI_BYOK_VAULT_KEY must decode to 32 bytes");
  }

  cachedVaultKey = decoded;
  return decoded;
}

function sanitizeOpenAiApiKey(apiKey: string): string {
  // Normalize common copy/paste variants without widening accepted key classes.
  const normalized = apiKey.trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
  if (!normalized.startsWith(OPENAI_KEY_PREFIX)) {
    throw new Error("Invalid OpenAI API key format");
  }

  if (normalized.length < OPENAI_KEY_MIN_LENGTH || normalized.length > OPENAI_KEY_MAX_LENGTH) {
    throw new Error("Invalid OpenAI API key format");
  }

  if (!PRINTABLE_ASCII_NO_SPACES_PATTERN.test(normalized)) {
    throw new Error("Invalid OpenAI API key format");
  }
  return normalized;
}

function fingerprintOpenAiApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function keyLast4(apiKey: string): string {
  return apiKey.slice(-4);
}

function encryptApiKey(apiKey: string): EncryptedPayload {
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, decodeVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedKey: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

function decryptApiKey(row: Pick<UserOpenAiKeyRow, "encrypted_key" | "iv" | "auth_tag">): string {
  const decipher = createDecipheriv(
    AES_ALGORITHM,
    decodeVaultKey(),
    Buffer.from(row.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_key, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function isOpenAiByokVaultEnabled(): boolean {
  return Boolean(env.OPENAI_BYOK_VAULT_KEY);
}

export async function getOpenAiByokStatus(userId: string): Promise<OpenAiByokStatus> {
  if (!isOpenAiByokVaultEnabled()) {
    return {
      vaultEnabled: false,
      configured: false,
      keyLast4: null,
      updatedAt: null,
    };
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_openai_keys")
    .select("key_last4,updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingVaultTableError(error.message)) {
      throw new Error("OpenAI BYOK vault table is missing. Apply database migrations.");
    }
    throw new Error(`Failed to query OpenAI BYOK status: ${error.message}`);
  }

  return {
    vaultEnabled: true,
    configured: Boolean(data),
    keyLast4: data?.key_last4 ?? null,
    updatedAt: data?.updated_at ?? null,
  };
}

export async function upsertUserOpenAiApiKey(userId: string, apiKeyInput: string): Promise<OpenAiByokStatus> {
  if (!isOpenAiByokVaultEnabled()) {
    throw new Error("OpenAI BYOK vault is not enabled");
  }

  const apiKey = sanitizeOpenAiApiKey(apiKeyInput);
  const encrypted = encryptApiKey(apiKey);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_openai_keys")
    .upsert(
      {
        user_id: userId,
        encrypted_key: encrypted.encryptedKey,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        key_version: env.OPENAI_BYOK_VAULT_KEY_VERSION,
        key_last4: keyLast4(apiKey),
        key_fingerprint: fingerprintOpenAiApiKey(apiKey),
        last_used_at: null,
      },
      {
        onConflict: "user_id",
      },
    )
    .select("key_last4,updated_at")
    .single();

  if (error) {
    if (isMissingVaultTableError(error.message)) {
      throw new Error("OpenAI BYOK vault table is missing. Apply database migrations.");
    }
    throw new Error(`Failed to store OpenAI BYOK key: ${error.message}`);
  }

  return {
    vaultEnabled: true,
    configured: true,
    keyLast4: data.key_last4,
    updatedAt: data.updated_at,
  };
}

export async function deleteUserOpenAiApiKey(userId: string): Promise<void> {
  if (!isOpenAiByokVaultEnabled()) {
    return;
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("user_openai_keys").delete().eq("user_id", userId);

  if (error) {
    if (isMissingVaultTableError(error.message)) {
      throw new Error("OpenAI BYOK vault table is missing. Apply database migrations.");
    }
    throw new Error(`Failed to delete OpenAI BYOK key: ${error.message}`);
  }
}

export async function resolveUserOpenAiApiKey(userId: string): Promise<string | null> {
  if (!isOpenAiByokVaultEnabled()) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_openai_keys")
    .select("encrypted_key,iv,auth_tag")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingVaultTableError(error.message)) {
      throw new Error("OpenAI BYOK vault table is missing. Apply database migrations.");
    }
    throw new Error(`Failed to resolve OpenAI BYOK key: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return decryptApiKey(data);
}

export async function markUserOpenAiApiKeyUsed(userId: string): Promise<void> {
  if (!isOpenAiByokVaultEnabled()) {
    return;
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("user_openai_keys")
    .update({
      last_used_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    if (isMissingVaultTableError(error.message)) {
      return;
    }
    throw new Error(`Failed to update OpenAI BYOK last_used_at: ${error.message}`);
  }
}
