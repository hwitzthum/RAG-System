// POST /api/ingest — the Kommandozentrale hands a document to the corpus.
//
// Like /api/run, this reimplements nothing: it mints a service-account token
// and calls the app's own /api/upload handler in-process, so the PDF signature
// check, the size cap, the content-hash dedup, the storage write and the
// ingestion-queue enqueue all happen exactly as they do for a person. The
// worker then indexes it on its own schedule, which is why the dashboard polls
// the status route beside this one instead of waiting here.

import { NextResponse, type NextRequest } from "next/server";

import { POST as upload } from "@/app/api/upload/route";
import { authenticated, configured } from "@/lib/integration/auth";
import {
  serviceAuthHeaders,
  ServiceUserError,
} from "@/lib/integration/service-user";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  if (!configured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a dashboard." },
      { status: 503 },
    );
  }

  if (!authenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Body must be multipart/form-data" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'A "file" part is required' },
      { status: 400 },
    );
  }

  try {
    const headers = await serviceAuthHeaders();

    // Rebuilt rather than forwarded: a FormData that has already been read
    // cannot be re-sent, and the upload route reads its own parts by name.
    const inner = new FormData();
    inner.set("file", file, file.name);
    const title = form.get("title");
    if (typeof title === "string" && title.trim())
      inner.set("title", title.trim());
    const language = form.get("language_hint");
    if (typeof language === "string" && language.trim()) {
      inner.set("language_hint", language.trim());
    }

    const response = await upload(
      new Request("https://internal.invalid/api/upload", {
        method: "POST",
        headers,
        body: inner,
        signal: request.signal,
      }) as NextRequest,
    );

    const payload = await response.json().catch(() => null);

    // Passed through untouched, including the refusals: "not a PDF", "too
    // large", "already exists" are the upload route's answers to give, and
    // rewording them here would only make them less true.
    return NextResponse.json(payload ?? {}, { status: response.status });
  } catch (error) {
    if (error instanceof ServiceUserError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[integration] ingest failed", error);
    return NextResponse.json({ error: "The upload failed." }, { status: 500 });
  }
}
