"use client";

import { useEffect, useRef } from "react";
import type { ConfirmAction } from "@/app/admin/admin-panel.types";

export function AdminConfirmDialog(props: {
  confirmAction: ConfirmAction | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (props.confirmAction) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [props.confirmAction]);

  return (
    <dialog
      ref={dialogRef}
      className="themed-dialog surface-card rounded-2xl p-6 shadow-xl"
      onClose={props.onCancel}
    >
      {props.confirmAction ? (
        <div className="min-w-[320px]">
          <p className="fg-primary text-sm">
            Are you sure you want to <strong>{props.confirmAction.label}</strong>?
          </p>
          {props.confirmAction.action === "delete" ? (
            <p className="tone-danger mt-2 text-sm font-semibold">This action cannot be undone.</p>
          ) : null}
          <div className="mt-4 flex gap-2">
            <button
              onClick={props.onConfirm}
              className={`active:scale-[0.98] rounded-2xl px-3 py-1 text-xs font-semibold ${
                props.confirmAction.action === "delete" ? "btn-danger" : "btn-primary"
              }`}
            >
              Confirm
            </button>
            <button
              onClick={props.onCancel}
              className="btn-secondary active:scale-[0.98] rounded-2xl px-3 py-1 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
