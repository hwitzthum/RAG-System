const DOCUMENT_OVERVIEW_PATTERNS = [
  /\bsummari[sz]e\b/,
  /\bsummary\b/,
  /\boverview\b/,
  /\bmain points?\b/,
  /\bwhat is (?:this|the) document about\b/,
  /\bwhat are the contents? of (?:this|the) document\b/,
  /\bwhat is the content of (?:this|the) document\b/,
  /\bwhat does (?:this|the) document contain\b/,
  /\bplease summarize\b/,
  /\bzusammenfass\w*\b/u,
  /\bfass(?:e|en)\b.*\bzusammen\b/u,
  /\büberblick\b/u,
  /\bworum geht es\b/u,
  /\bwas ist der inhalt\b/u,
  /\bwas sind die inhalte\b/u,
  /\bwas steht in (?:diesem|dem) dokument\b/u,
  /\br[ée]sum[ée]\b/u,
  /\br[ée]sume(?:r|z)\b/u,
  /\bcontenu du document\b/u,
  /\bde quoi parle (?:ce|le) document\b/u,
  /\bvue d['’]ensemble\b/u,
  /\bsintesi\b/u,
  /\briassum(?:i|ere)\b/u,
  /\bcontenuto del documento\b/u,
  /\bdi cosa parla (?:questo|il) documento\b/u,
  /\bpanoramica\b/u,
  /\bresumen\b/u,
  /\bresum(?:e|ir)\b/u,
  /\bcontenido del documento\b/u,
  /\bde qu[ée] trata (?:este|el) documento\b/u,
  /\bvisi[óo]n general\b/u,
];

export function isDocumentOverviewQuery(normalizedQuery: string, documentIds: string[]): boolean {
  if (documentIds.length !== 1 || normalizedQuery.length === 0) {
    return false;
  }

  return DOCUMENT_OVERVIEW_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
}
