import { RagWorkbench } from "@/components/rag-workbench";
import { getServerSessionUser } from "@/lib/auth/server-session";

const PHASE_CHECKLIST = [
  "SSE query streaming and grounded answer generation",
  "Citation rendering and source linking in the chat workspace",
  "Admin PDF upload controls with ingestion status visibility",
  "User query-history endpoint and timeline UI",
  "Responsive desktop/mobile layout and role-aware actions",
];

export default async function HomePage() {
  const sessionUser = await getServerSessionUser();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-5 py-10 md:px-8">
      <header className="rounded-2xl border border-cyan-100 bg-gradient-to-r from-cyan-950 via-slate-900 to-emerald-900 px-6 py-7 text-white shadow-lg">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">RAG System</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Phase 10 Frontend Workspace</h1>
        <p className="mt-2 max-w-3xl text-sm text-cyan-50/90">
          Streaming chat answers, citation traceability, upload operations, and query-history workflows.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Phase 10 Deliverables</h2>
        <ul className="space-y-2 text-sm text-slate-700">
          {PHASE_CHECKLIST.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <span aria-hidden="true" className="text-emerald-600">
                [ok]
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <RagWorkbench initialUser={sessionUser} />
    </main>
  );
}
