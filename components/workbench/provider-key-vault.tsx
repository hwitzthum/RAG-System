import type { ProviderKeyVaultProps } from "./types";
import { formatTime } from "./types";

/**
 * Bring-your-own-key vault for a single provider.
 *
 * This is an advanced, rarely-touched setting sitting in a 288px rail, so it
 * stays collapsed and carries its state on the closed row — the common case is
 * reading "is a key set?", not editing one. Expanded, it is a flat block rather
 * than a card-inside-a-card: nesting a padded tile inside the rail's own
 * padding is what previously squeezed the controls until they broke out of it.
 */
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
  const vaultDisabled = !status?.vaultEnabled;
  const configured = Boolean(status?.configured);

  const stateBadge = vaultDisabled
    ? { label: "Off", className: "badge-muted" }
    : configured
      ? { label: "Active", className: "badge-success" }
      : { label: "Not set", className: "badge-muted" };

  const detail = vaultDisabled
    ? "Vault disabled"
    : configured
      ? `Key ending ${status?.keyLast4 ?? "????"}`
      : "No user key — using the server key";

  return (
    <details className="group border-t border-[var(--border)] pt-4">
      <summary className="disclosure-summary">
        <span className="label-caps">{providerLabel} API Key</span>
        <span className={`badge ml-auto ${stateBadge.className}`}>
          {stateBadge.label}
        </span>
      </summary>

      <div className="mt-4 space-y-3">
        <input
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          type="password"
          placeholder={placeholder}
          disabled={!user}
          autoComplete="off"
          className="input-surface w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          data-testid={`${providerSlug}-byok-input`}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={saveKey}
            disabled={loading || !user}
            className="btn-solid px-4 py-2 text-[10px] disabled:cursor-not-allowed"
          >
            {loading ? "Saving" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setInputValue("")}
            disabled={!user || inputValue.length === 0}
            className="btn-secondary px-4 py-2 text-[10px] disabled:opacity-40"
          >
            Clear
          </button>
        </div>

        {/* Low-frequency actions sit with the status line, not beside Save. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--border)] pt-3">
          <p className="fg-muted text-[11px]">
            {detail}
            {status?.updatedAt ? ` · ${formatTime(status.updatedAt)}` : ""}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={loadStatus}
              disabled={!user || loading}
              className="label-caps px-1 py-0.5 transition hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={deleteKey}
              disabled={!configured || loading}
              className="label-caps px-1 py-0.5 transition hover:text-[var(--danger)] disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}
