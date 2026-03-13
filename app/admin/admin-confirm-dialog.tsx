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
      className="rounded-xl border border-zinc-200 bg-white p-6 shadow-xl backdrop:bg-black/40"
      onClose={props.onCancel}
    >
      {props.confirmAction ? (
        <div className="min-w-[320px]">
          <p className="text-sm text-zinc-900">
            Are you sure you want to <strong>{props.confirmAction.label}</strong>?
          </p>
          {props.confirmAction.action === "delete" ? (
            <p className="mt-2 text-sm font-semibold text-rose-700">This action cannot be undone.</p>
          ) : null}
          <div className="mt-4 flex gap-2">
            <button
              onClick={props.onConfirm}
              className={`active:scale-[0.98] transition-all duration-150 rounded-lg px-3 py-1 text-xs font-semibold text-white ${
                props.confirmAction.action === "delete" ? "bg-rose-700 hover:bg-rose-800" : "bg-amber-700 hover:bg-amber-800"
              }`}
            >
              Confirm
            </button>
            <button
              onClick={props.onCancel}
              className="active:scale-[0.98] transition-all duration-150 rounded-lg border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
