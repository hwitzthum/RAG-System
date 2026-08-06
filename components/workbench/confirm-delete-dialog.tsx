"use client";

import { useEffect, useRef } from "react";

/** Irreversible-delete gate for documents. `documentName` null means closed. */
export function ConfirmDeleteDialog(props: {
  documentName: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (props.documentName !== null) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [props.documentName]);

  return (
    <dialog
      ref={dialogRef}
      className="themed-dialog surface-card p-8"
      onClose={props.onCancel}
      data-testid="confirm-delete-dialog"
    >
      {props.documentName !== null ? (
        <div className="min-w-[320px] max-w-[420px]">
          <p className="fg-primary text-sm">
            Delete <strong>{props.documentName}</strong>?
          </p>
          <p className="tone-danger mt-3 text-sm">
            This removes the document, all of its chunks and embeddings, and the
            stored file. It cannot be undone.
          </p>
          <div className="mt-8 flex gap-2">
            <button
              type="button"
              onClick={props.onConfirm}
              className="btn-danger px-4 py-2 text-[11px]"
              data-testid="confirm-delete-confirm"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={props.onCancel}
              className="btn-secondary px-4 py-2 text-[11px]"
              data-testid="confirm-delete-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
