import { env } from "@/lib/config/env";
import { createProviderVault } from "@/lib/providers/byok-vault";

const OPENAI_KEY_PREFIX = "sk-";
const OPENAI_KEY_MIN_LENGTH = 20;
const OPENAI_KEY_MAX_LENGTH = 512;
const PRINTABLE_ASCII_NO_SPACES_PATTERN = /^[\x21-\x7E]+$/;

function sanitizeOpenAiApiKey(apiKey: string): string {
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

const openAiVault = createProviderVault({
  providerLabel: "OpenAI",
  tableName: "user_openai_keys",
  keyConfig: {
    envValue: env.OPENAI_BYOK_VAULT_KEY,
    envName: "OPENAI_BYOK_VAULT_KEY",
    keyVersion: env.OPENAI_BYOK_VAULT_KEY_VERSION,
  },
  sanitizeApiKey: sanitizeOpenAiApiKey,
});

export type OpenAiByokStatus = Awaited<ReturnType<typeof openAiVault.getStatus>>;

export const isOpenAiByokVaultEnabled = openAiVault.isVaultEnabled;
export const getOpenAiByokStatus = openAiVault.getStatus;
export const upsertUserOpenAiApiKey = openAiVault.upsertUserApiKey;
export const deleteUserOpenAiApiKey = openAiVault.deleteUserApiKey;
export const resolveUserOpenAiApiKey = openAiVault.resolveUserApiKey;
export const markUserOpenAiApiKeyUsed = openAiVault.markUserApiKeyUsed;
