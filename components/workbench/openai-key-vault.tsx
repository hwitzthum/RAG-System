import { ProviderKeyVault } from "./provider-key-vault";
import type { ProviderKeyVaultProps } from "./types";

export function OpenAiKeyVault(props: Omit<ProviderKeyVaultProps, "providerLabel" | "providerSlug" | "placeholder">) {
  return (
    <ProviderKeyVault
      providerLabel="OpenAI"
      providerSlug="openai"
      placeholder="OpenAI API key (sk-...)"
      {...props}
    />
  );
}
