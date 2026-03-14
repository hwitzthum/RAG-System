"use client";

import { useState } from "react";
import type { SidebarRightProps } from "./types";
import { getDocumentDisplayName, getMessageToneClass } from "./types";
import { ProviderKeyVault } from "./provider-key-vault";

type Tab = "evidence" | "upload" | "status";

export function SidebarRight({
  activeTurn,
  uploadFileInputRef,
  handleUploadFileChange,
  uploadTitle,
  setUploadTitle,
  uploadLanguageHint,
  setUploadLanguageHint,
  handleUploadButtonClick,
  uploading,
  uploadFile,
  canUpload,
  canDeleteDocuments,
  userRole,
  batchFileInputRef,
  handleBatchUpload,
  batchFiles,
  uploadStatus,
  onDeleteDocument,
  workspaceMessage,
  documents,
  documentsLoading,
  queryDocumentScopeIds,
  toggleQueryDocumentScopeId,
  clearQueryDocumentScope,
  providerVaults,
}: SidebarRightProps) {
  const [activeTab, setActiveTab] = useState<Tab>("evidence");
  const workspaceToneClass = getMessageToneClass(workspaceMessage);

  const tabs: { key: Tab; label: string }[] = [
    { key: "evidence", label: "Evidence" },
    { key: "upload", label: "Upload" },
    { key: "status", label: "Status" },
  ];

  return (
    <aside className="nav-surface hidden w-[320px] shrink-0 flex-col overflow-y-auto border-l lg:flex">
      {/* Tab Bar */}
      <div className="flex border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-3 py-2.5 text-xs font-medium transition ${
              activeTab === tab.key
                ? "border-b-2 border-[var(--accent)] text-[var(--accent-strong)]"
                : "fg-muted hover:text-[var(--text-primary)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Evidence Tab */}
        {activeTab === "evidence" && (
          <section>
            <h3 className="fg-secondary text-xs font-medium">Evidence Navigator</h3>
            <p className="fg-muted mt-0.5 text-xs">Citations for the selected answer.</p>
            <div className="mt-2 space-y-1.5">
              {activeTurn?.citations.length ? (
                activeTurn.citations.map((citation) => {
                  const doc = documents.find((d) => d.id === citation.documentId);
                  const docName = doc ? getDocumentDisplayName(doc) : citation.documentId.slice(0, 8);
                  return (
                    <a
                      key={`${citation.documentId}:${citation.pageNumber}:${citation.chunkId}`}
                      className="surface-muted fg-secondary block rounded-2xl px-3 py-2 text-xs hover:border-[var(--accent-border)]"
                      href={`/api/upload/${citation.documentId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <p><span className="fg-primary font-medium">Doc:</span> {docName}</p>
                      <p><span className="fg-primary font-medium">Page:</span> {citation.pageNumber}</p>
                      <p><span className="fg-primary font-medium">Chunk:</span> {citation.chunkId.slice(0, 12)}</p>
                    </a>
                  );
                })
              ) : (
                <p className="fg-muted rounded-2xl border border-dashed border-[var(--border)] px-3 py-4 text-xs">
                  No citations for this turn yet.
                </p>
              )}
            </div>
          </section>
        )}

        {/* Upload Tab */}
        {activeTab === "upload" && (
          <div className="space-y-4">
            {/* Ingestion Desk */}
            <section>
              <h3 className="fg-secondary text-xs font-medium">Ingestion Desk</h3>
              <div className="mt-2 space-y-2">
                <input
                  ref={uploadFileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  className="file-input-surface block w-full text-xs"
                  onChange={handleUploadFileChange}
                  data-testid="single-upload-input"
                />
                <label htmlFor="upload-title-input" className="fg-secondary text-xs font-medium">
                  Document Title
                </label>
                <input
                  id="upload-title-input"
                  name="document_title"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  placeholder="Optional title"
                  className="input-surface w-full rounded-2xl px-3 py-2 text-sm"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid="upload-title-input"
                />
                <select
                  value={uploadLanguageHint}
                  onChange={(e) => setUploadLanguageHint(e.target.value)}
                  className="input-surface w-full rounded-2xl px-3 py-2 text-sm"
                >
                  <option value="">Language hint (optional)</option>
                  <option value="EN">EN</option>
                  <option value="DE">DE</option>
                  <option value="FR">FR</option>
                  <option value="IT">IT</option>
                  <option value="ES">ES</option>
                </select>
                <button
                  type="button"
                  onClick={handleUploadButtonClick}
                  disabled={uploading}
                  className="btn-primary w-full rounded-2xl px-3 py-2 text-sm font-medium disabled:cursor-not-allowed active:scale-[0.98]"
                  data-testid="upload-submit-button"
                >
                  {uploading ? "Uploading..." : uploadFile ? "Upload PDF" : "Select PDF"}
                </button>
                {!canUpload ? (
                  <p className="fg-muted text-xs">Create a session first. Current role: {userRole ?? "none"}.</p>
                ) : !uploadFile ? (
                  <p className="fg-muted text-xs">Select a PDF file to enable upload.</p>
                ) : (
                  <p className="fg-secondary text-xs">Selected: {uploadFile.name}</p>
                )}
                {/* Document Scope Selector */}
                <div className="mt-1">
                  <div className="flex items-center justify-between">
                    <label className="fg-secondary text-xs font-medium">
                      Query Scope
                    </label>
                    {queryDocumentScopeIds.length > 0 ? (
                      <button
                        type="button"
                        onClick={clearQueryDocumentScope}
                        className="btn-ghost rounded px-1.5 py-0.5 text-xs font-medium"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <p className="fg-muted mt-0.5 text-xs">
                    {queryDocumentScopeIds.length > 0
                      ? `${queryDocumentScopeIds.length} document${queryDocumentScopeIds.length === 1 ? "" : "s"} selected`
                      : "All documents"}
                  </p>
                  <div className="surface-muted mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-2xl p-2">
                    <label className="fg-secondary flex items-center gap-2 rounded px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        checked={queryDocumentScopeIds.length === 0}
                        onChange={() => clearQueryDocumentScope()}
                        className="check-accent h-3.5 w-3.5 rounded"
                        disabled={documentsLoading}
                      />
                      <span>All documents</span>
                    </label>
                    {documents.map((doc) => {
                      const checked = queryDocumentScopeIds.includes(doc.id);
                      return (
                        <label
                          key={doc.id}
                          className="fg-secondary flex items-center gap-2 rounded px-2 py-1 text-xs transition hover:bg-[var(--bg-elevated)]"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleQueryDocumentScopeId(doc.id)}
                            className="check-accent h-3.5 w-3.5 rounded"
                            disabled={documentsLoading}
                          />
                          <span className="truncate">
                            {getDocumentDisplayName(doc)} ({doc.status})
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Batch Upload */}
              <div className="mt-3 space-y-2">
                <p className="fg-secondary text-xs font-medium">Batch Upload</p>
                <input
                  ref={batchFileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  multiple
                  className="file-input-surface block w-full text-xs"
                  onChange={handleBatchUpload}
                  data-testid="batch-upload-input"
                />
                {batchFiles.length > 0 ? (
                  <div className="space-y-1">
                    {batchFiles.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2 text-xs">
                        <span className="fg-secondary truncate">{entry.file.name}</span>
                        <span
                          className={`badge ${
                            entry.status === "failed"
                              ? "badge-danger"
                              : entry.status === "queued"
                                ? "badge-success"
                                : entry.status === "uploading"
                                  ? "badge-warning"
                                  : "badge-muted"
                          }`}
                        >
                          {entry.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {/* Upload Status */}
              {uploadStatus ? (
                <div className="surface-muted fg-secondary mt-3 rounded-2xl p-3 text-xs" data-testid="upload-status-panel">
                  <p><span className="fg-primary font-medium">Document:</span> {getDocumentDisplayName(uploadStatus.document)}</p>
                  <p><span className="fg-primary font-medium">Status:</span> {uploadStatus.document.status}</p>
                  <p><span className="fg-primary font-medium">Job:</span> {uploadStatus.latestIngestionJob?.status ?? "n/a"}</p>
                  {uploadStatus.latestIngestionJob?.last_error ? (
                    <p><span className="fg-primary font-medium">Error:</span> {uploadStatus.latestIngestionJob.last_error}</p>
                  ) : null}
                  {canDeleteDocuments ? (
                    <button
                      type="button"
                      onClick={() => onDeleteDocument(uploadStatus.document.id)}
                      className="btn-danger mt-2 w-full rounded-2xl px-3 py-1.5 text-xs font-medium active:scale-[0.98]"
                      data-testid="delete-document-button"
                    >
                      Delete Document
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>

            {/* BYOK Vault */}
            {providerVaults.map((providerVault) => (
              <ProviderKeyVault key={providerVault.providerSlug} {...providerVault} />
            ))}
          </div>
        )}

        {/* Status Tab */}
        {activeTab === "status" && (
          <section>
            <h3 className="fg-secondary text-xs font-medium">Status</h3>
            <p aria-live="polite" className={`mt-1 text-xs leading-relaxed ${workspaceToneClass}`} data-testid="workspace-status-message">
              {workspaceMessage}
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}
