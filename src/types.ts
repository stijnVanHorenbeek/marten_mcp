export interface CacheMetadata {
  sourceUrl: string;
  fetchedAt: string;
  lastValidatedAt: string;
  etag: string | null;
  lastModified: string | null;
  sha256: string;
  chunkCount: number;
  parserVersion: string;
  indexVersion: string;
}

export interface CachePaths {
  dir: string;
  docsFile: string;
  metadataFile: string;
  validationHistoryFile: string;
}

export interface PageDoc {
  path: string;
  title: string;
  raw: string;
}

export type ParseMode = "strict" | "fallback" | "single-page-fallback";

export interface ParseDiagnostics {
  mode: ParseMode;
  pageMarkerCount: number;
  malformedMarkerCount: number;
  warnings: string[];
}

export interface DocChunk {
  id: string;
  path: string;
  title: string;
  headings: string[];
  body_text: string;
  code_text: string;
  raw_text: string;
  order: number;
  pageOrder: number;
}

export interface PageSummary {
  path: string;
  title: string;
  chunkCount: number;
}

export type SearchMode = "auto" | "lexical" | "trigram" | "exact";
export type ContextMode = "section" | "page";

export interface SearchFieldWeights {
  title: number;
  headings: number;
  path: number;
  body: number;
  code: number;
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  headings: string[];
  score: number;
  lexicalScore: number;
  trigramScore: number;
  snippet: string;
  debug?: {
    decidedMode: SearchMode;
    queryClass: SearchMode;
    phraseBoost: number;
    codeBoost: number;
    shortQueryFallback: boolean;
  };
}

export interface FreshnessState {
  isFreshWithinSoftTtl: boolean;
  isBeyondHardTtl: boolean;
  softTtlMs: number;
  hardTtlMs: number;
  ageSinceValidationMs: number;
}

export interface ValidationFailureRecord {
  at: string;
  message: string;
}

export interface StatusReport {
  sourceUrl: string;
  cachePath: string;
  hasCache: boolean;
  freshness: {
    state: "fresh" | "stale-soft" | "stale-hard" | "missing";
    softTtlHours: number;
    hardTtlHours: number;
    ageSinceValidationHours: number | null;
    lastValidationError: string | null;
    validationBackoff: {
      active: boolean;
      retryInSeconds: number | null;
      consecutiveFailures: number;
    };
    validationFailureHistory: ValidationFailureRecord[];
    backgroundRefresh: {
      running: boolean;
      lastStartedAt: string | null;
      lastFinishedAt: string | null;
      lastResult: "updated" | "unchanged" | "failed" | null;
    };
  };
  metadata: CacheMetadata | null;
  index: {
    ready: boolean;
    chunkCount: number;
    pageCount: number;
    parserVersion: string;
    indexVersion: string;
    parseDiagnostics: ParseDiagnostics | null;
  };
}
