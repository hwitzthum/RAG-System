import type { ProviderKeyVaultProps } from "./types";
import { formatTime } from "./types";

export function ProviderKeyVault({
  providerLabel,
  providerSlug,
  placeholder,
  user,
  inputValue,
  setInputValue,
  status,
  loading,
  saveKey,
  deleteKey,
  loadStatus,
}: ProviderKeyVaultProps) {
  const vaultStatusText = status?.vaultEnabled
    ? status.configured
      ? `Configured (****${status.keyLast4 ?? "????"})`
      : "Vault enabled, no user key"
    : "Vault disabled";

  return (
    <div className="border-t border-zinc-200 bg-zinc-50 p-3">
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-zinc-500 group-open:mb-3">
          {providerLabel} API Key
        </summary>

        <div className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-600">BYOK Vault</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={loadStatus}
                disabled={!user || loading}
                className="rounded px-2 py-1 text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={deleteKey}
                disabled={!status?.configured || loading}
                className="rounded px-2 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-40"
              >
                Delete Key
              </button>
            </div>
          </div>
          <input
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            type="password"
            placeholder={placeholder}
            disabled={!user}
            autoComplete="off"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid={`${providerSlug}-byok-input`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveKey}
              disabled={loading || !user}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:bg-zinc-300 active:scale-[0.98]"
            >
              {loading ? "Saving..." : "Save Key"}
            </button>
            <button
              type="button"
              onClick={() => setInputValue("")}
              disabled={!user}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 active:scale-[0.98]"
            >
              Clear Input
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            {vaultStatusText}
            {status?.updatedAt ? ` | Updated ${formatTime(status.updatedAt)}` : ""}
          </p>
        </div>
      </details>
    </div>
  );
}
