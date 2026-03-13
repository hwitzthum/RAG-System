import Link from "next/link";

export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-zinc-900">404</h1>
        <p className="mt-2 text-zinc-500">This page could not be found.</p>
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-700 hover:underline">
          Go to workspace
        </Link>
      </div>
    </div>
  );
}
