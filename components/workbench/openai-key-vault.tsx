import type { OpenAiKeyVaultProps } from "./types";
import { formatTime } from "./types";

export function OpenAiKeyVault({
  user,
  openAiByokInput,
  setOpenAiByokInput,
  openAiByokStatus,
  openAiByokLoading,
  saveOpenAiByokKey,
  deleteOpenAiByokKey,
  loadOpenAiByokStatus,
}: OpenAiKeyVaultProps) {
  const vaultStatusText = openAiByokStatus?.vaultEnabled
    ? openAiByokStatus.configured
      ? `Configured (****${openAiByokStatus.keyLast4 ?? "????"})`
      : "Vault enabled, no user key"
    : "Vault disabled";

  return (
    <div className="border-t border-zinc-200 bg-zinc-50 p-4">
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-zinc-500 group-open:mb-3">
          OpenAI API Key
        </summary>

        <div className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-600">BYOK Vault</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={loadOpenAiByokStatus}
                disabled={!user || openAiByokLoading}
                className="rounded px-2 py-1 text-[10px] font-medium text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={deleteOpenAiByokKey}
                disabled={!openAiByokStatus?.configured || openAiByokLoading}
                className="rounded px-2 py-1 text-[10px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-40"
              >
                Delete Key
              </button>
            </div>
          </div>
          <input
            value={openAiByokInput}
            onChange={(e) => setOpenAiByokInput(e.target.value)}
            type="password"
            placeholder="OpenAI API key (sk-...)"
            disabled={!user}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveOpenAiByokKey}
              disabled={openAiByokLoading || !user}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:bg-zinc-300 active:scale-[0.98]"
            >
              {openAiByokLoading ? "Saving..." : "Save Key"}
            </button>
            <button
              type="button"
              onClick={() => setOpenAiByokInput("")}
              disabled={!user}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 active:scale-[0.98]"
            >
              Clear Input
            </button>
          </div>
          <p className="text-[10px] text-zinc-400">
            {vaultStatusText}
            {openAiByokStatus?.updatedAt ? ` | Updated ${formatTime(openAiByokStatus.updatedAt)}` : ""}
          </p>
        </div>
      </details>
    </div>
  );
}
