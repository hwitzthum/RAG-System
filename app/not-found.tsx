export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-slate-900">404</h1>
        <p className="mt-2 text-slate-600">This page could not be found.</p>
        <a href="/login" className="mt-4 inline-block text-teal-800 hover:underline">
          Go to login
        </a>
      </div>
    </div>
  );
}