import { ThemeSelector } from "@/components/theme/theme-selector";
import { RautakiWordmark } from "@/components/brand/rautaki-wordmark";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="auth-shell flex items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-end">
          <ThemeSelector />
        </div>
        <div className="mb-10">
          <RautakiWordmark size="md" tagline />
        </div>
        <div className="auth-card surface-card">{children}</div>
        <p className="label-caps mt-8 text-center">RAG Workspace</p>
      </div>
    </main>
  );
}
