import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const AES_ALGORITHM = "aes-256-gcm";
const AES_IV_BYTES = 12;
const AES_KEY_BYTES = 32;
const PRINTABLE_ASCII_NO_SPACES_PATTERN = /^[\x21-\x7E]+$/;

type VaultTableRow = {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  key_last4: string;
  updated_at: string;
};

type VaultKeyConfig = {
  envValue: string | undefined;
  envName: string;
  keyVersion: number;
};

type VaultTableName = "user_openai_keys" | "user_cohere_keys" | "user_anthropic_keys";

type ProviderVaultConfig = {
  providerLabel: string;
  tableName: VaultTableName;
  keyConfig: VaultKeyConfig;
  sanitizeApiKey: (apiKey: string) => string;
};

export type ProviderByokStatus = {
  vaultEnabled: boolean;
  configured: boolean;
  keyLast4: string | null;
  updatedAt: string | null;
};

type EncryptedPayload = {
  encryptedKey: string;
  iv: string;
  authTag: string;
};

const cachedVaultKeys = new Map<string, Buffer>();

function decodeVaultKey(config: VaultKeyConfig): Buffer {
  const cached = cachedVaultKeys.get(config.envName);
  if (cached) {
    return cached;
  }

  if (!config.envValue) {
    throw new Error(`${config.envName} is not configured`);
  }

  const decoded = Buffer.from(config.envValue, "base64");
  if (decoded.length !== AES_KEY_BYTES) {
    throw new Error(`${config.envName} must decode to 32 bytes`);
  }

  cachedVaultKeys.set(config.envName, decoded);
  return decoded;
}

function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function keyLast4(apiKey: string): string {
  return apiKey.slice(-4);
}

function isMissingVaultTableError(tableName: string, message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes(tableName.toLowerCase()) &&
    (normalized.includes("does not exist") || normalized.includes("could not find the table"));
}

function encryptApiKey(apiKey: string, config: VaultKeyConfig): EncryptedPayload {
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, decodeVaultKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedKey: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

function decryptApiKey(row: Pick<VaultTableRow, "encrypted_key" | "iv" | "auth_tag">, config: VaultKeyConfig): string {
  const decipher = createDecipheriv(
    AES_ALGORITHM,
    decodeVaultKey(config),
    Buffer.from(row.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_key, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function sanitizeLooseProviderApiKey(apiKey: string, providerLabel: string): string {
  const normalized = apiKey.trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
  if (normalized.length < 20 || normalized.length > 512) {
    throw new Error(`Invalid ${providerLabel} API key format`);
  }

  if (!PRINTABLE_ASCII_NO_SPACES_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${providerLabel} API key format`);
  }

  return normalized;
}

export function createProviderVault(config: ProviderVaultConfig) {
  function isVaultEnabled(): boolean {
    return Boolean(config.keyConfig.envValue);
  }

  async function getStatus(userId: string): Promise<ProviderByokStatus> {
    if (!isVaultEnabled()) {
      return {
        vaultEnabled: false,
        configured: false,
        keyLast4: null,
        updatedAt: null,
      };
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from(config.tableName)
      .select("key_last4,updated_at")
      .eq("user_id", userId)
      .maybeSingle<{ key_last4: string; updated_at: string }>();

    if (error) {
      if (isMissingVaultTableError(config.tableName, error.message)) {
        throw new Error(`${config.providerLabel} BYOK vault table is missing. Apply database migrations.`);
      }
      throw new Error(`Failed to query ${config.providerLabel} BYOK status: ${error.message}`);
    }

    return {
      vaultEnabled: true,
      configured: Boolean(data),
      keyLast4: data?.key_last4 ?? null,
      updatedAt: data?.updated_at ?? null,
    };
  }

  async function upsertUserApiKey(userId: string, apiKeyInput: string): Promise<ProviderByokStatus> {
    if (!isVaultEnabled()) {
      throw new Error(`${config.providerLabel} BYOK vault is not enabled`);
    }

    const apiKey = config.sanitizeApiKey(apiKeyInput);
    const encrypted = encryptApiKey(apiKey, config.keyConfig);
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from(config.tableName)
      .upsert(
        {
          user_id: userId,
          encrypted_key: encrypted.encryptedKey,
          iv: encrypted.iv,
          auth_tag: encrypted.authTag,
          key_version: config.keyConfig.keyVersion,
          key_last4: keyLast4(apiKey),
          key_fingerprint: fingerprintApiKey(apiKey),
          last_used_at: null,
        },
        {
          onConflict: "user_id",
        },
      )
      .select("key_last4,updated_at")
      .single<{ key_last4: string; updated_at: string }>();

    if (error) {
      if (isMissingVaultTableError(config.tableName, error.message)) {
        throw new Error(`${config.providerLabel} BYOK vault table is missing. Apply database migrations.`);
      }
      throw new Error(`Failed to store ${config.providerLabel} BYOK key: ${error.message}`);
    }

    return {
      vaultEnabled: true,
      configured: true,
      keyLast4: data.key_last4,
      updatedAt: data.updated_at,
    };
  }

  async function deleteUserApiKey(userId: string): Promise<void> {
    if (!isVaultEnabled()) {
      return;
    }

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from(config.tableName).delete().eq("user_id", userId);

    if (error) {
      if (isMissingVaultTableError(config.tableName, error.message)) {
        throw new Error(`${config.providerLabel} BYOK vault table is missing. Apply database migrations.`);
      }
      throw new Error(`Failed to delete ${config.providerLabel} BYOK key: ${error.message}`);
    }
  }

  async function resolveUserApiKey(userId: string): Promise<string | null> {
    if (!isVaultEnabled()) {
      return null;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from(config.tableName)
      .select("encrypted_key,iv,auth_tag")
      .eq("user_id", userId)
      .maybeSingle<VaultTableRow>();

    if (error) {
      if (isMissingVaultTableError(config.tableName, error.message)) {
        throw new Error(`${config.providerLabel} BYOK vault table is missing. Apply database migrations.`);
      }
      throw new Error(`Failed to resolve ${config.providerLabel} BYOK key: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return decryptApiKey(data, config.keyConfig);
  }

  async function markUserApiKeyUsed(userId: string): Promise<void> {
    if (!isVaultEnabled()) {
      return;
    }

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
      .from(config.tableName)
      .update({
        last_used_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (error && !isMissingVaultTableError(config.tableName, error.message)) {
      throw new Error(`Failed to update ${config.providerLabel} BYOK last_used_at: ${error.message}`);
    }
  }

  return {
    isVaultEnabled,
    getStatus,
    upsertUserApiKey,
    deleteUserApiKey,
    resolveUserApiKey,
    markUserApiKeyUsed,
  };
}
