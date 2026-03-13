import type { DevSessionControlsProps } from "./types";

export function DevSessionControls({
  token,
  setToken,
  createSession,
  clearSession,
}: DevSessionControlsProps) {
  return (
    <div className="border-t border-zinc-200 bg-zinc-50 p-4">
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-zinc-500 group-open:mb-3">
          Dev Session
        </summary>

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
      </details>
    </div>
  );
}
