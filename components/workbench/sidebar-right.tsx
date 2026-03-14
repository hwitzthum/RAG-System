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
    <aside className="hidden w-[320px] shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white lg:flex">
      {/* Tab Bar */}
      <div className="flex border-b border-zinc-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-3 py-2.5 text-xs font-medium transition ${
              activeTab === tab.key
                ? "border-b-2 border-indigo-600 text-indigo-600"
                : "text-zinc-500 hover:text-zinc-700"
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
            <h3 className="text-xs font-medium text-zinc-500">Evidence Navigator</h3>
            <p className="mt-0.5 text-xs text-zinc-400">Citations for the selected answer.</p>
            <div className="mt-2 space-y-1.5">
              {activeTurn?.citations.length ? (
                activeTurn.citations.map((citation) => {
                  const doc = documents.find((d) => d.id === citation.documentId);
                  const docName = doc ? getDocumentDisplayName(doc) : citation.documentId.slice(0, 8);
                  return (
                    <a
                      key={`${citation.documentId}:${citation.pageNumber}:${citation.chunkId}`}
                      className="block rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 transition hover:bg-zinc-100"
                      href={`/api/upload/${citation.documentId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <p><span className="font-medium text-zinc-700">Doc:</span> {docName}</p>
                      <p><span className="font-medium text-zinc-700">Page:</span> {citation.pageNumber}</p>
                      <p><span className="font-medium text-zinc-700">Chunk:</span> {citation.chunkId.slice(0, 12)}</p>
                    </a>
                  );
                })
              ) : (
                <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-zinc-400">
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
              <h3 className="text-xs font-medium text-zinc-500">Ingestion Desk</h3>
              <div className="mt-2 space-y-2">
                <input
                  ref={uploadFileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  className="block w-full text-xs text-zinc-600 file:mr-2 file:rounded-lg file:border file:border-zinc-200 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-700 hover:file:bg-zinc-50"
                  onChange={handleUploadFileChange}
                  data-testid="single-upload-input"
                />
                <label htmlFor="upload-title-input" className="text-xs font-medium text-zinc-500">
                  Document Title
                </label>
                <input
                  id="upload-title-input"
                  name="document_title"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  placeholder="Optional title"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder:text-zinc-400"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid="upload-title-input"
                />
                <select
                  value={uploadLanguageHint}
                  onChange={(e) => setUploadLanguageHint(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
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
                  className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 active:scale-[0.98]"
                  data-testid="upload-submit-button"
                >
                  {uploading ? "Uploading..." : uploadFile ? "Upload PDF" : "Select PDF"}
                </button>
                {!canUpload ? (
                  <p className="text-xs text-zinc-400">Create a session first. Current role: {userRole ?? "none"}.</p>
                ) : !uploadFile ? (
                  <p className="text-xs text-zinc-400">Select a PDF file to enable upload.</p>
                ) : (
                  <p className="text-xs text-zinc-500">Selected: {uploadFile.name}</p>
                )}
                {/* Document Scope Selector */}
                <div className="mt-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-zinc-500">
                      Query Scope
                    </label>
                    {queryDocumentScopeIds.length > 0 ? (
                      <button
                        type="button"
                        onClick={clearQueryDocumentScope}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {queryDocumentScopeIds.length > 0
                      ? `${queryDocumentScopeIds.length} document${queryDocumentScopeIds.length === 1 ? "" : "s"} selected`
                      : "All documents"}
                  </p>
                  <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                    <label className="flex items-center gap-2 rounded px-2 py-1 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        checked={queryDocumentScopeIds.length === 0}
                        onChange={() => clearQueryDocumentScope()}
                        className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600"
                        disabled={documentsLoading}
                      />
                      <span>All documents</span>
                    </label>
                    {documents.map((doc) => {
                      const checked = queryDocumentScopeIds.includes(doc.id);
                      return (
                        <label
                          key={doc.id}
                          className="flex items-center gap-2 rounded px-2 py-1 text-xs text-zinc-600 transition hover:bg-white"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleQueryDocumentScopeId(doc.id)}
                            className="h-3.5 w-3.5 rounded border-zinc-300 text-indigo-600"
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
                <p className="text-xs font-medium text-zinc-500">Batch Upload</p>
                <input
                  ref={batchFileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  multiple
                  className="block w-full text-xs text-zinc-600 file:mr-2 file:rounded-lg file:border file:border-zinc-200 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-700 hover:file:bg-zinc-50"
                  onChange={handleBatchUpload}
                  data-testid="batch-upload-input"
                />
                {batchFiles.length > 0 ? (
                  <div className="space-y-1">
                    {batchFiles.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2 text-xs">
                        <span className="truncate text-zinc-600">{entry.file.name}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            entry.status === "failed"
                              ? "border border-rose-200 bg-rose-50 text-rose-700"
                              : entry.status === "queued"
                                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                                : entry.status === "uploading"
                                  ? "border border-amber-200 bg-amber-50 text-amber-700"
                                  : "border border-zinc-200 bg-zinc-50 text-zinc-500"
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
                <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600" data-testid="upload-status-panel">
                  <p><span className="font-medium">Document:</span> {getDocumentDisplayName(uploadStatus.document)}</p>
                  <p><span className="font-medium">Status:</span> {uploadStatus.document.status}</p>
                  <p><span className="font-medium">Job:</span> {uploadStatus.latestIngestionJob?.status ?? "n/a"}</p>
                  {uploadStatus.latestIngestionJob?.last_error ? (
                    <p><span className="font-medium">Error:</span> {uploadStatus.latestIngestionJob.last_error}</p>
                  ) : null}
                  {canDeleteDocuments ? (
                    <button
                      type="button"
                      onClick={() => onDeleteDocument(uploadStatus.document.id)}
                      className="mt-2 w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-100 active:scale-[0.98]"
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
            <h3 className="text-xs font-medium text-zinc-500">Status</h3>
            <p aria-live="polite" className={`mt-1 text-xs leading-relaxed ${workspaceToneClass}`} data-testid="workspace-status-message">
              {workspaceMessage}
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}
