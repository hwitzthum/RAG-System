import {
  findUnsupportedPremise,
  type UnsupportedPremise,
} from "@/lib/answering/premise";
import { countChunksMatchingTerms } from "@/lib/retrieval/repository";

/**
 * The premise check, composed once for every caller that runs a query.
 *
 * It lives apart from `premise.ts` so that module stays pure and directly
 * testable, and apart from the answering service so that service keeps taking
 * its evidence as an argument rather than reaching for the database.
 *
 * Having exactly one composition matters more than the layering, though. The
 * benchmark calls `generateGroundedAnswer` directly rather than going through
 * `/api/query`, so anything wired only into the route is invisible to the
 * measurements — a gate could be live in production and score zero on the
 * evaluation, or pass the evaluation and never run for a user. Both callers
 * now go through here.
 */
export async function resolveUnsupportedPremise(input: {
  question: string;
  /** Readable documents, or null for a caller who may read all of them. */
  documentIds: string[] | null;
}): Promise<UnsupportedPremise | null> {
  return findUnsupportedPremise({
    question: input.question,
    documentIds: input.documentIds,
    countMatches: countChunksMatchingTerms,
  });
}
