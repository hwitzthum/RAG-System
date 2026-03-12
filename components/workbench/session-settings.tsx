import type { SessionSettingsProps } from "./types";
import { formatTime } from "./types";

export function SessionSettings({
  user,
  token,
  setToken,
  createSession,
  clearSession,
  openAiByokInput,
  setOpenAiByokInput,
  openAiByokStatus,
  openAiByokLoading,
  saveOpenAiByokKey,
  deleteOpenAiByokKey,
  loadOpenAiByokStatus,
}: SessionSettingsProps) {
  const vaultStatusText = openAiByokStatus?.vaultEnabled
    ? openAiByokStatus.configured
      ? `Configured (****${openAiByokStatus.keyLast4 ?? "????"})`
      : "Vault enabled, no user key"
    : "Vault disabled";



  return (
    <div className="border-t border-zinc-200 bg-zinc-50 p-4">
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-zinc-500 group-open:mb-3">
          Dev Session & BYOK
        </summary>

        {/* Session token input */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste Supabase access token"
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400"
            />
            <button
              type="button"
              onClick={createSession}
              className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-zinc-800 active:scale-[0.98]"
            >
              Create Session
            </button>
            <button
              type="button"
              onClick={clearSession}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 active:scale-[0.98]"
            >
              Clear
            </button>
          </div>
        </div>

        {/* BYOK Vault */}
        <div className="mt-3 space-y-2 rounded-lg border border-zinc-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-600">OpenAI BYOK Vault</p>
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
