export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[linear-gradient(135deg,rgba(16,24,38,0.95),rgba(28,34,48,0.95),rgba(18,91,89,0.9))] px-4">
      <div className="w-full max-w-md rounded-[28px] border border-[#d9cab7] bg-[linear-gradient(160deg,rgba(255,251,245,0.96),rgba(255,247,237,0.92))] p-8 shadow-[0_36px_80px_-42px_rgba(15,23,42,0.85)]">
        {children}
      </div>
    </main>
  );
}
