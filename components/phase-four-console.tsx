"use client";

import { useMemo, useState } from "react";
import type { Role } from "@/lib/auth/types";

type SessionUser = {
  id: string;
  role: Role;
  email: string | null;
} | null;

type PhaseFourConsoleProps = {
  initialUser: SessionUser;
};

export function PhaseFourConsole({ initialUser }: PhaseFourConsoleProps) {
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [output, setOutput] = useState<string>("");
  const [user, setUser] = useState<SessionUser>(initialUser);

  const canQuery = useMemo(() => user?.role === "reader" || user?.role === "admin", [user]);
  const canUpload = useMemo(() => user?.role === "reader" || user?.role === "admin", [user]);

  async function createSession() {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: token }),
    });

    const payload = await response.json();
    setOutput(JSON.stringify(payload, null, 2));

    if (response.ok) {
      setUser(payload.user);
    }
  }

  async function clearSession() {
    const response = await fetch("/api/auth/session", { method: "DELETE" });
    const payload = await response.json();
    setOutput(JSON.stringify(payload, null, 2));
    if (response.ok) {
      setUser(null);
    }
  }

  async function executeQuery() {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const payload = await response.json();
    setOutput(JSON.stringify(payload, null, 2));
  }

  async function uploadPdf() {
    if (!file) {
      setOutput("Please choose a PDF file first.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    setOutput(JSON.stringify(payload, null, 2));
  }

  return (
    <section className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Phase 4 Security Console</h2>
        <p className="text-sm text-slate-600">
          Session creation, role-gated actions, and secured API routes.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Current Session</p>
        <p className="text-sm text-slate-700">
          {user ? `user=${user.id}, role=${user.role}, email=${user.email ?? "n/a"}` : "No active session"}
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="token">
          Access Token
        </label>
        <input
          id="token"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="Paste Supabase access token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
            onClick={createSession}
          >
            Create Session
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
            onClick={clearSession}
          >
            Clear Session
          </button>
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4">
        <p className="text-sm font-medium">Query (reader/admin)</p>
        <textarea
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          rows={3}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ask a question"
        />
        <button
          type="button"
          className="rounded-md bg-cyan-700 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          onClick={executeQuery}
          disabled={!canQuery || query.trim().length === 0}
        >
          Execute Query
        </button>
        {!canQuery ? <p className="text-xs text-slate-500">Requires role reader or admin.</p> : null}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4">
        <p className="text-sm font-medium">Upload (reader/admin)</p>
        <input
          type="file"
          accept="application/pdf"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="block w-full text-sm"
        />
        <button
          type="button"
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          onClick={uploadPdf}
          disabled={!canUpload || !file}
        >
          Upload PDF
        </button>
        {!canUpload ? <p className="text-xs text-slate-500">Requires role reader or admin.</p> : null}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4">
        <p className="text-sm font-medium">Response</p>
        <pre className="max-h-72 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
          {output || "No response yet"}
        </pre>
      </div>
    </section>
  );
}
