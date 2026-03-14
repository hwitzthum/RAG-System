import { env } from "@/lib/config/env";
import { createProviderVault, sanitizeLooseProviderApiKey } from "@/lib/providers/byok-vault";

const cohereVault = createProviderVault({
  providerLabel: "Cohere",
  tableName: "user_cohere_keys",
  keyConfig: {
    envValue: env.COHERE_BYOK_VAULT_KEY,
    envName: "COHERE_BYOK_VAULT_KEY",
    keyVersion: env.COHERE_BYOK_VAULT_KEY_VERSION,
  },
  sanitizeApiKey(apiKey: string) {
    return sanitizeLooseProviderApiKey(apiKey, "Cohere");
  },
});

export type CohereByokStatus = Awaited<ReturnType<typeof cohereVault.getStatus>>;

export const isCohereByokVaultEnabled = cohereVault.isVaultEnabled;
export const getCohereByokStatus = cohereVault.getStatus;
export const upsertUserCohereApiKey = cohereVault.upsertUserApiKey;
export const deleteUserCohereApiKey = cohereVault.deleteUserApiKey;
export const resolveUserCohereApiKey = cohereVault.resolveUserApiKey;
export const markUserCohereApiKeyUsed = cohereVault.markUserApiKeyUsed;
