import Link from "next/link";

export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface-card text-center rounded-3xl px-10 py-12">
        <h1 className="fg-primary text-4xl font-bold">404</h1>
        <p className="fg-muted mt-2">This page could not be found.</p>
        <Link href="/" className="link-accent mt-4 inline-block">
          Go to workspace
        </Link>
      </div>
    </div>
  );
}
