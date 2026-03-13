export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-sm font-semibold text-zinc-900">RAG Workspace</p>
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
