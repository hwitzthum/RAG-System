import { retrieveRankedCandidates } from '@/lib/retrieval/service';
import { hasSufficientEvidence } from '@/lib/answering/policy';

async function main() {
  const result = await retrieveRankedCandidates({
    query: 'Give me the key achievements of this project',
    topK: 8,
    documentIds: ['e9c4189d-1fa9-4367-af21-39d6f5db817e'],
    cacheNamespace: 'debug-test-' + Date.now(),
  });

  console.log('candidateCounts:', JSON.stringify(result.trace.candidateCounts));
  console.log('language:', result.trace.language);
  console.log('chunks returned:', result.chunks.length);
  for (const c of result.chunks.slice(0, 5)) {
    console.log('  chunk:', c.chunkId.slice(0,8), 'retrieval:', c.retrievalScore.toFixed(4), 'rerank:', (c.rerankScore ?? 0).toFixed(4));
  }
  const sufficient = hasSufficientEvidence({ chunks: result.chunks, minEvidenceChunks: 1, minRerankScore: 0.1 });
  console.log('hasSufficientEvidence:', sufficient);
}

main().catch(console.error);
