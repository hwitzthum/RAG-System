"use client";

import { useMemo, useRef, useState } from "react";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canQuery = useMemo(() => user?.role === "reader" || user?.role === "admin", [user]);
  const canUpload = useMemo(() => Boolean(user), [user]);

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
    if (!user) {
      setOutput("Create a session before uploading.");
      return;
    }

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

  async function uploadSelectedFile(selectedFile: File): Promise<void> {
    setFile(selectedFile);
    if (!user) {
      setOutput("Create a session before uploading.");
      return;
    }

    const formData = new FormData();
    formData.append("file", selectedFile);

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    setOutput(JSON.stringify(payload, null, 2));
  }

  function handleUploadButtonClick() {
    if (!file) {
      fileInputRef.current?.click();
      setOutput("Please choose a PDF file first.");
      return;
    }

    void uploadPdf();
  }

  return (
    <section className="surface-card space-y-8 p-8">
      <div>
        <h2 className="display-4">Security Console</h2>
        <p className="fg-secondary mt-2 text-sm">
          Session creation, role-gated actions, and secured API routes.
        </p>
      </div>

      <div className="space-y-2">
        <p className="section-label section-label-sub">Current Session</p>
        <p className="fg-secondary text-sm">
          {user ? `user=${user.id}, role=${user.role}, email=${user.email ?? "n/a"}` : "No active session"}
        </p>
      </div>

      <div className="space-y-2">
        <label className="label-caps block" htmlFor="token">
          Access Token
        </label>
        <input
          id="token"
          className="input-surface w-full px-3 py-2 text-sm"
          placeholder="Paste Supabase access token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary px-4 py-2 text-[11px]"
            onClick={createSession}
          >
            Create Session
          </button>
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-[11px]"
            onClick={clearSession}
          >
            Clear Session
          </button>
        </div>
      </div>

      <div className="space-y-3 border-t border-[var(--border)] pt-6">
        <p className="section-label section-label-sub">Query (reader/admin)</p>
        <textarea
          className="input-surface w-full px-3 py-2 text-sm"
          rows={3}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ask a question"
        />
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[11px] disabled:cursor-not-allowed"
          onClick={executeQuery}
          disabled={!canQuery || query.trim().length === 0}
        >
          Execute Query
        </button>
        {!canQuery ? <p className="fg-muted text-xs">Requires role reader or admin.</p> : null}
      </div>

      <div className="space-y-3 border-t border-[var(--border)] pt-6">
        <p className="section-label section-label-sub">Upload (authenticated session)</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setFile(selected);
            if (selected) {
              void uploadSelectedFile(selected);
            }
          }}
          className="file-input-surface block w-full text-sm"
        />
        <button
          type="button"
          className="btn-primary px-4 py-2 text-[11px]"
          onClick={handleUploadButtonClick}
        >
          {file ? "Upload PDF" : "Select PDF"}
        </button>
        {!canUpload ? <p className="fg-muted text-xs">Create a session before uploading.</p> : null}
      </div>

      <div className="space-y-3 border-t border-[var(--border)] pt-6">
        <p className="section-label section-label-sub">Response</p>
        <pre className="surface-muted fg-primary max-h-72 overflow-auto p-4 font-mono text-xs">
          {output || "No response yet"}
        </pre>
      </div>
    </section>
  );
}
