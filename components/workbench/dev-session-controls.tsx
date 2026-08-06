import type { DevSessionControlsProps } from "./types";

export function DevSessionControls({
  token,
  setToken,
  createSession,
  clearSession,
}: DevSessionControlsProps) {
  return (
    <div className="nav-surface border-t p-5">
      <details className="group">
        <summary className="label-caps cursor-pointer group-open:mb-3">
          Dev Session
        </summary>

        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste Supabase access token"
              className="input-surface flex-1 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={createSession}
              className="btn-primary px-4 py-2 text-[10px]"
            >
              Create Session
            </button>
            <button
              type="button"
              onClick={clearSession}
              className="btn-secondary px-4 py-2 text-[10px]"
            >
              Clear
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
