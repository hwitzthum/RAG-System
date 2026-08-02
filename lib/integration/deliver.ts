// Hands a finished answer to the Kommandozentrale (dashboard F2.1's intake).
//
// Same contract every integrated app implements: multipart, a `result` JSON
// part, one file part per deliverable whose field name is its label. See
// docs/INTEGRATION.md in the rautaki-dashboard repository.

import { APP_ID } from "@/lib/integration/manifest";
import {
  sourcesToMarkdown,
  type AnswerSource,
} from "@/lib/integration/answer-markdown";

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export function deliveryConfigured(): boolean {
  return Boolean(
    process.env.RAUTAKI_DASHBOARD_URL && process.env.RAUTAKI_RESULTS_TOKEN,
  );
}

/** A question is its own best title; only its length needs deciding. */
function titleFor(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, " ");
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

export async function deliverAnswer({
  question,
  answer,
  sources,
  clientRef,
  meta,
  signal,
}: {
  question: string;
  answer: string;
  sources: AnswerSource[];
  clientRef: string;
  meta: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ resultId: string; resultUrl: string; replayed: boolean }> {
  const base = process.env.RAUTAKI_DASHBOARD_URL!.replace(/\/$/, "");

  const form = new FormData();
  form.set(
    "result",
    JSON.stringify({
      title: titleFor(question),
      kind: "answer",
      body: answer,
      clientRef,
      meta: {
        app: APP_ID,
        question,
        sources,
        ...meta,
      },
    }),
  );

  // The answer with its sources as one readable file: a delivery in the feed
  // should not depend on the dashboard knowing how to render `meta`.
  form.append(
    "Antwort mit Quellen",
    new File([sourcesToMarkdown(question, answer, sources)], "antwort.md", {
      type: "text/markdown",
    }),
  );

  let response: Response;
  try {
    response = await fetch(`${base}/api/results`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RAUTAKI_RESULTS_TOKEN!}`,
      },
      body: form,
      signal,
    });
  } catch (error) {
    throw new DeliveryError(
      `Could not reach the dashboard: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    id?: string;
    replayed?: boolean;
    error?: string;
  } | null;

  if (!response.ok || !payload?.id) {
    throw new DeliveryError(
      payload?.error ??
        `The dashboard refused the delivery (${response.status})`,
      502,
    );
  }

  return {
    resultId: payload.id,
    resultUrl: `${base}/results/${payload.id}`,
    replayed: payload.replayed === true,
  };
}
