import { AsyncLocalStorage } from "node:async_hooks";

type RuntimeSecrets = {
  openAiApiKey?: string;
  cohereApiKey?: string;
  anthropicApiKey?: string;
};

const runtimeSecretsStorage = new AsyncLocalStorage<RuntimeSecrets>();

function sanitizeSecretValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

export function runWithRuntimeSecrets<T>(secrets: RuntimeSecrets, handler: () => Promise<T>): Promise<T> {
  return runtimeSecretsStorage.run(
    {
      openAiApiKey: sanitizeSecretValue(secrets.openAiApiKey),
      cohereApiKey: sanitizeSecretValue(secrets.cohereApiKey),
      anthropicApiKey: sanitizeSecretValue(secrets.anthropicApiKey),
    },
    handler,
  );
}

export function getRuntimeSecrets(): RuntimeSecrets {
  return runtimeSecretsStorage.getStore() ?? {};
}
