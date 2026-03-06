import { RagWorkbench } from "@/components/rag-workbench";
import { getServerSessionUser } from "@/lib/auth/server-session";

const CAPABILITY_CARDS = [
  {
    title: "Grounded Answers",
    detail: "Real-time token streaming with transparent source citations for every response.",
  },
  {
    title: "Secure Access",
    detail: "Encrypted BYOK model credentials with strict role-aware session controls.",
  },
  {
    title: "Ingestion Visibility",
    detail: "Document upload and indexing progress surfaced directly in the workspace.",
  },
  {
    title: "Operational Recall",
    detail: "Session history and one-click query replay for rapid iterative investigation.",
  },
];

const UX_PRINCIPLES = [
  "Single-surface workflow for identity, retrieval, and ingestion operations",
  "High-information layout with clear hierarchy and reduced cognitive overhead",
  "Responsive controls and status feedback tuned for daily production usage",
];

export default async function HomePage() {
  const sessionUser = await getServerSessionUser();
  const buildDateLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(new Date());

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-5 py-8 md:px-8 md:py-12">
      <header className="relative overflow-hidden rounded-[34px] border border-[#d7c7b3] bg-[linear-gradient(135deg,rgba(16,24,38,0.95),rgba(28,34,48,0.95),rgba(18,91,89,0.9))] px-6 py-8 text-white shadow-[0_36px_80px_-42px_rgba(15,23,42,0.85)] md:px-10 md:py-10">
        <div className="pointer-events-none absolute -right-20 -top-16 h-52 w-52 rounded-full bg-orange-400/25 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 bottom-0 h-44 w-44 rounded-full bg-teal-300/20 blur-3xl" />
        <p className="relative text-xs font-semibold uppercase tracking-[0.28em] text-teal-100">Knowledge Operations Suite</p>
        <h1 className="font-display relative mt-2 max-w-4xl text-4xl leading-tight tracking-tight md:text-5xl">
          Enterprise Retrieval Command Center
        </h1>
        <p className="relative mt-3 max-w-3xl text-sm leading-relaxed text-slate-100/90 md:text-base">
          A professional operator interface for secure session orchestration, evidence-grounded generation, and
          production document ingestion workflows.
        </p>
        <div className="relative mt-5 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-100/90">
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1">Streaming Responses</span>
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1">Source Traceability</span>
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1">BYOK Security</span>
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1">Updated {buildDateLabel}</span>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        {CAPABILITY_CARDS.map((card) => (
          <article
            key={card.title}
            className="rounded-[24px] border border-[#d9cab7] bg-[linear-gradient(160deg,rgba(255,251,245,0.92),rgba(255,247,237,0.84))] p-5 shadow-[0_24px_56px_-40px_rgba(15,23,42,0.75)]"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-900/85">Capability</p>
            <h2 className="font-display mt-1 text-2xl leading-tight text-slate-900">{card.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{card.detail}</p>
          </article>
        ))}
      </section>

      <section className="rounded-[28px] border border-[#d9cab7] bg-[linear-gradient(160deg,rgba(255,251,245,0.92),rgba(255,247,237,0.84))] p-5 shadow-[0_26px_60px_-44px_rgba(15,23,42,0.75)] md:p-6">
        <h2 className="font-display text-2xl leading-tight text-slate-900 md:text-3xl">UX Design Principles</h2>
        <p className="mt-1 text-sm text-slate-600">Intentional design decisions to maximize operational clarity.</p>
        <ul className="mt-5 grid gap-2.5 text-sm text-slate-700 md:grid-cols-3">
          {UX_PRINCIPLES.map((item) => (
            <li key={item} className="flex gap-3 rounded-xl border border-[#e4d8c8] bg-white/70 px-3.5 py-3">
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-teal-300 bg-teal-50 text-[11px] font-bold text-teal-800"
              >
                +
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-[28px] border border-[#d9cab7] bg-[linear-gradient(160deg,rgba(255,251,245,0.92),rgba(255,247,237,0.84))] p-5 shadow-[0_26px_60px_-44px_rgba(15,23,42,0.75)] md:p-6">
        <h2 className="font-display text-2xl leading-tight text-slate-900 md:text-3xl">Operational Surface</h2>
        <p className="mt-1 text-sm text-slate-600">
          Execute secure queries, inspect evidence, manage uploads, and monitor system state in one consolidated view.
        </p>
      </section>

      <RagWorkbench initialUser={sessionUser} />
    </main>
  );
}
