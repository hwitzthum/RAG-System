// POST /api/run — the Kommandozentrale asks the corpus a question.
//
// The retrieval, ranking, answering and safety logic is NOT reimplemented here.
// This mints a service-account token, calls the app's own /api/query handler
// in-process, and reads the `final` event off its SSE stream.
//
// That is the point. /api/query is where the prompt-injection guard, the rate
// limits, the BYOK resolution, the caching, the query-expansion routing and the
// audit logging live. A parallel path beside it would be free to drift into
// answering without one of them, and the dashboard would be the only place that
// difference showed. It also means the audit trail names the service account —
// a true record of who asked.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { POST as query } from "@/app/api/query/route";
import { authenticated, configured } from "@/lib/integration/auth";
import {
  deliverAnswer,
  DeliveryError,
  deliveryConfigured,
} from "@/lib/integration/deliver";
import { APP_ID, askInputSchema } from "@/lib/integration/manifest";
import {
  serviceAuthHeaders,
  ServiceUserError,
} from "@/lib/integration/service-user";
import { resolveSources } from "@/lib/integration/sources";

export const runtime = "nodejs";
// The answer path is seconds; this waits for it, so it matches /api/query's own
// ceiling rather than cutting below it.
export const maxDuration = 120;

type FinalEvent = {
  queryId: string;
  answer: string;
  citations: Array<{ documentId: string; pageNumber: number; chunkId: string }>;
  retrievalMeta?: {
    insufficientEvidence?: boolean;
    cacheHit?: boolean;
    latencyMs?: number;
  };
  queryHistoryId?: string;
};

export async function POST(request: NextRequest) {
  if (!configured() || !deliveryConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a dashboard." },
      { status: 503 },
    );
  }

  if (!authenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = askInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const { question, topK, enableWebResearch, clientRef } = parsed.data;

  let final: FinalEvent | null = null;
  try {
    const headers = await serviceAuthHeaders();
    const inner = await query(
      new Request("https://internal.invalid/api/query", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          query: question,
          ...(topK ? { topK } : {}),
          ...(enableWebResearch ? { enableWebResearch } : {}),
        }),
        signal: request.signal,
      }) as NextRequest,
    );

    if (!inner.ok || !inner.body) {
      const detail = (await inner.json().catch(() => null)) as {
        error?: string;
      } | null;
      return NextResponse.json(
        { error: detail?.error ?? "The RAG system refused the query." },
        { status: inner.status },
      );
    }

    final = await readFinalEvent(inner.body);
  } catch (error) {
    if (error instanceof ServiceUserError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[integration] query failed", error);
    return NextResponse.json({ error: "The query failed." }, { status: 500 });
  }

  if (!final) {
    return NextResponse.json(
      { error: "The query produced no answer." },
      { status: 502 },
    );
  }

  const sources = await resolveSources(final.citations ?? []);

  try {
    const delivered = await deliverAnswer({
      question,
      answer: final.answer,
      sources,
      // The caller's ref when it sent one; the query's own id otherwise, which
      // at least ties the delivery to the run that produced it.
      clientRef: clientRef ?? final.queryId,
      meta: {
        queryId: final.queryId,
        queryHistoryId: final.queryHistoryId ?? null,
        insufficientEvidence:
          final.retrievalMeta?.insufficientEvidence ?? false,
        cacheHit: final.retrievalMeta?.cacheHit ?? false,
        latencyMs: final.retrievalMeta?.latencyMs ?? null,
      },
      signal: request.signal,
    });

    return NextResponse.json({
      ok: true,
      app: APP_ID,
      answer: final.answer,
      sources,
      // Said plainly rather than left for the reader to infer from an empty
      // source list: the corpus had nothing to answer from.
      insufficientEvidence: final.retrievalMeta?.insufficientEvidence ?? false,
      ...delivered,
    });
  } catch (error) {
    if (error instanceof DeliveryError) {
      // The answer exists and was paid for; hand it back even though the
      // dashboard would not take it, and say what went wrong.
      return NextResponse.json(
        {
          ok: false,
          app: APP_ID,
          answer: final.answer,
          sources,
          error: error.message,
        },
        { status: error.status },
      );
    }
    throw error;
  }
}

/** Reads the SSE stream and keeps the one event that carries the answer. */
async function readFinalEvent(
  body: ReadableStream<Uint8Array>,
): Promise<FinalEvent | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: FinalEvent | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; each carries `event:` and `data:`.
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");

      const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
      if (event !== "final") continue;

      const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
      if (!data) continue;

      try {
        final = JSON.parse(data) as FinalEvent;
      } catch {
        // A malformed frame is the stream's problem; keep reading rather than
        // throwing away an answer that may still arrive.
      }
    }
  }

  return final;
}
