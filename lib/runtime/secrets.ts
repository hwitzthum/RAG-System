import { AsyncLocalStorage } from "node:async_hooks";

type RuntimeSecrets = {
  openAiApiKey?: string;
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
    },
    handler,
  );
}

export function getRuntimeSecrets(): RuntimeSecrets {
  return runtimeSecretsStorage.getStore() ?? {};
}
