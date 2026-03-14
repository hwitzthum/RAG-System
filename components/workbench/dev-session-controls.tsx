import type { DevSessionControlsProps } from "./types";

export function DevSessionControls({
  token,
  setToken,
  createSession,
  clearSession,
}: DevSessionControlsProps) {
  return (
    <div className="nav-surface border-t p-4">
      <details className="group">
        <summary className="fg-secondary cursor-pointer text-xs font-medium group-open:mb-3">
          Dev Session
        </summary>

        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste Supabase access token"
              className="input-surface flex-1 rounded-2xl px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={createSession}
              className="btn-primary rounded-2xl px-3 py-2 text-xs font-medium active:scale-[0.98]"
            >
              Create Session
            </button>
            <button
              type="button"
              onClick={clearSession}
              className="btn-secondary rounded-2xl px-3 py-2 text-xs font-medium active:scale-[0.98]"
            >
              Clear
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
