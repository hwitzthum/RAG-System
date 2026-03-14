export const dynamic = "force-dynamic";

import { ThemeSelector } from "@/components/theme/theme-selector";
import PendingApprovalForm from "./pending-form";

export default function PendingApprovalPage() {
  return (
    <main className="auth-shell flex items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-4 flex justify-end">
          <ThemeSelector />
        </div>
        <p className="fg-primary mb-6 text-center text-sm font-semibold">RAG Workspace</p>
        <div className="auth-card surface-card">
          <PendingApprovalForm />
        </div>
      </div>
    </main>
  );
}
