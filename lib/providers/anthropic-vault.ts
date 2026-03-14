import { env } from "@/lib/config/env";
import { createProviderVault, sanitizeLooseProviderApiKey } from "@/lib/providers/byok-vault";

const anthropicVault = createProviderVault({
  providerLabel: "Anthropic",
  tableName: "user_anthropic_keys",
  keyConfig: {
    envValue: env.ANTHROPIC_BYOK_VAULT_KEY,
    envName: "ANTHROPIC_BYOK_VAULT_KEY",
    keyVersion: env.ANTHROPIC_BYOK_VAULT_KEY_VERSION,
  },
  sanitizeApiKey(apiKey: string) {
    return sanitizeLooseProviderApiKey(apiKey, "Anthropic");
  },
});

export type AnthropicByokStatus = Awaited<ReturnType<typeof anthropicVault.getStatus>>;

export const isAnthropicByokVaultEnabled = anthropicVault.isVaultEnabled;
export const getAnthropicByokStatus = anthropicVault.getStatus;
export const upsertUserAnthropicApiKey = anthropicVault.upsertUserApiKey;
export const deleteUserAnthropicApiKey = anthropicVault.deleteUserApiKey;
export const resolveUserAnthropicApiKey = anthropicVault.resolveUserApiKey;
export const markUserAnthropicApiKeyUsed = anthropicVault.markUserApiKeyUsed;
