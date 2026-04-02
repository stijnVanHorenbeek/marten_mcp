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

export type SearchMode = "auto" | "lexical" | "trigram" | "exact";

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  headings: string[];
  score: number;
  lexicalScore: number;
  trigramScore: number;
  snippet: string;
}

export interface FreshnessState {
  isFreshWithinSoftTtl: boolean;
  isBeyondHardTtl: boolean;
  softTtlMs: number;
  hardTtlMs: number;
  ageSinceValidationMs: number;
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
