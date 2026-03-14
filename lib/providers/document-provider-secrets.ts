import { markUserAnthropicApiKeyUsed, resolveUserAnthropicApiKey } from "@/lib/providers/anthropic-vault";
import { markUserOpenAiApiKeyUsed, resolveUserOpenAiApiKey } from "@/lib/providers/openai-vault";

export async function resolveDocumentProviderSecrets(input: {
  userId: string | null;
  fallbackOpenAiApiKey: string | null;
  fallbackAnthropicApiKey: string | null;
}): Promise<{
  openAiApiKey: string | null;
  anthropicApiKey: string | null;
}> {
  if (!input.userId) {
    return {
      openAiApiKey: input.fallbackOpenAiApiKey,
      anthropicApiKey: input.fallbackAnthropicApiKey,
    };
  }

  const [userOpenAiApiKey, userAnthropicApiKey] = await Promise.all([
    resolveUserOpenAiApiKey(input.userId),
    resolveUserAnthropicApiKey(input.userId),
  ]);

  if (userOpenAiApiKey) {
    void markUserOpenAiApiKeyUsed(input.userId).catch(() => undefined);
  }

  if (userAnthropicApiKey) {
    void markUserAnthropicApiKeyUsed(input.userId).catch(() => undefined);
  }

  return {
    openAiApiKey: userOpenAiApiKey ?? input.fallbackOpenAiApiKey,
    anthropicApiKey: userAnthropicApiKey ?? input.fallbackAnthropicApiKey,
  };
}
