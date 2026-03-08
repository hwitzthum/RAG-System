export const dynamic = "force-dynamic";

import PendingApprovalForm from "./pending-form";

export default function PendingApprovalPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[linear-gradient(135deg,#fefdfb,#f7f0e7)] p-4">
      <div className="w-full max-w-md rounded-3xl border border-[#d9c9b4] bg-white/95 p-8 shadow-[0_24px_64px_-36px_rgba(15,23,42,0.68)]">
        <PendingApprovalForm />
      </div>
    </main>
  );
}
