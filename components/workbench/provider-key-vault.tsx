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
    <div className="border-t border-[var(--border)] p-3">
      <details className="group">
        <summary className="fg-secondary cursor-pointer text-xs font-medium group-open:mb-3">
          {providerLabel} API Key
        </summary>

        <div className="surface-muted mt-3 space-y-2 rounded-2xl p-3">
          <div className="flex items-center justify-between">
            <p className="fg-secondary text-xs font-medium">BYOK Vault</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={loadStatus}
                disabled={!user || loading}
                className="btn-ghost rounded px-2 py-1 text-xs font-medium disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={deleteKey}
                disabled={!status?.configured || loading}
                className="btn-danger rounded px-2 py-1 text-xs font-medium disabled:opacity-40"
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
            className="input-surface w-full rounded-2xl px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            data-testid={`${providerSlug}-byok-input`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveKey}
              disabled={loading || !user}
              className="btn-primary rounded-2xl px-3 py-1.5 text-xs font-medium active:scale-[0.98]"
            >
              {loading ? "Saving..." : "Save Key"}
            </button>
            <button
              type="button"
              onClick={() => setInputValue("")}
              disabled={!user}
              className="btn-secondary rounded-2xl px-3 py-1.5 text-xs font-medium disabled:opacity-50 active:scale-[0.98]"
            >
              Clear Input
            </button>
          </div>
          <p className="fg-muted text-xs">
            {vaultStatusText}
            {status?.updatedAt ? ` | Updated ${formatTime(status.updatedAt)}` : ""}
          </p>
        </div>
      </details>
    </div>
  );
}
