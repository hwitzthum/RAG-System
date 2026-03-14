import { ThemeSelector } from "@/components/theme/theme-selector";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell flex items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-4 flex justify-end">
          <ThemeSelector />
        </div>
        <p className="fg-primary mb-6 text-center text-sm font-semibold">RAG Workspace</p>
        <div className="auth-card surface-card">
          {children}
        </div>
      </div>
    </main>
  );
}
