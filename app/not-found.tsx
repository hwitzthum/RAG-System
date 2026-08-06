import Link from "next/link";

export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface-card w-full max-w-md px-12 py-14">
        <hr className="rule-gold mb-10 w-16" />
        <h1 className="display-1">404</h1>
        <p className="fg-secondary mt-4 text-sm">
          This page could not be found.
        </p>
        <Link href="/" className="link-accent mt-8 inline-block text-sm">
          Go to workspace
        </Link>
      </div>
    </div>
  );
}
