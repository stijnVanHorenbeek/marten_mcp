import type {
  ContextMode,
  DocChunk,
  HybridIndexPersistedState,
  PageSummary,
  SearchMode,
  SearchResult
} from "./types.js";
import { SEARCH_FIELD_WEIGHTS } from "./config.js";
import {
  includesPhraseCaseInsensitive,
  normalizeWhitespace,
  tokenize,
  trigrams
} from "./util.js";

interface IndexedChunk {
  chunk: DocChunk;
  lexicalTerms: string[];
  lexicalTermFrequency: Map<string, number>;
  lexicalLength: number;
  trigramTerms: string[];
}

interface ScoredChunk {
  chunk: DocChunk;
  lexicalScore: number;
  trigramScore: number;
  score: number;
}

interface QueryProfile {
  raw: string;
  lexicalTerms: string[];
  trigramTerms: string[];
  identifierTerms: string[];
  queryClass: SearchMode;
  symbolHeavy: boolean;
  shortQuery: boolean;
}

export class HybridIndex {
  private readonly chunks: DocChunk[];
  private readonly byId: Map<string, DocChunk>;
  private readonly chunksByPath: Map<string, DocChunk[]>;
  private readonly lexicalPostings: Map<string, Set<string>>;
  private readonly trigramPostings: Map<string, Set<string>>;
  private readonly preIndexed: Map<string, IndexedChunk>;
  private readonly lexicalDocFrequencies: Map<string, number>;
  private avgLexicalDocLength: number;

  public constructor(chunks: DocChunk[], persistedState?: HybridIndexPersistedState | null) {
    this.chunks = chunks;
    this.byId = new Map(chunks.map((x) => [x.id, x]));
    this.chunksByPath = new Map();
    this.lexicalPostings = new Map();
    this.trigramPostings = new Map();
    this.preIndexed = new Map();
    this.lexicalDocFrequencies = new Map();
    this.avgLexicalDocLength = 0;

    const hydrated = persistedState ? this.hydrateFromPersistedState(persistedState) : false;
    if (!hydrated) {
      this.build();
      return;
    }

    this.buildChunksByPath();
  }

  public search(query: string, limit: number, mode: SearchMode = "auto", debug = false, offset = 0): SearchResult[] {
    const profile = buildQueryProfile(query);
    const trimmedQuery = profile.raw;
    const shortQuery = profile.shortQuery;
    const symbolHeavy = profile.symbolHeavy;
    const flexiblePhraseMatch = symbolHeavy || shortQuery;
    const queryKind = profile.queryClass;
    const useHybridAuto = mode === "auto" && !shortQuery;
    const decidedMode = mode === "auto" ? (shortQuery ? "exact" : queryKind) : mode;
    const lexicalTerms = profile.lexicalTerms;
    const trigramTerms = profile.trigramTerms;
    const identifierTerms = profile.identifierTerms;

    const lexicalCandidates = this.collectCandidates(this.lexicalPostings, lexicalTerms);
    const trigramCandidates = this.collectCandidates(this.trigramPostings, trigramTerms);
    const candidateIds = new Set<string>();

    if (useHybridAuto) {
      lexicalCandidates.forEach((id) => candidateIds.add(id));
      trigramCandidates.forEach((id) => candidateIds.add(id));
    } else if (decidedMode === "lexical") {
      lexicalCandidates.forEach((id) => candidateIds.add(id));
    } else if (decidedMode === "trigram") {
      trigramCandidates.forEach((id) => candidateIds.add(id));
    } else if (decidedMode === "exact") {
      this.chunks.forEach((chunk) => {
        if (isExactMatchCandidate(chunk, trimmedQuery, flexiblePhraseMatch)) {
          candidateIds.add(chunk.id);
        }
      });
    } else {
      lexicalCandidates.forEach((id) => candidateIds.add(id));
      trigramCandidates.forEach((id) => candidateIds.add(id));
    }

    const scoredById = new Map<
      string,
      {
        chunk: DocChunk;
        lexicalScore: number;
        trigramScore: number;
        phraseBoost: number;
        codeBoost: number;
      }
    >();

    for (const id of candidateIds) {
      const indexed = this.preIndexed.get(id);
      if (!indexed) {
        continue;
      }

      const lexicalScore =
        this.scoreLexical(indexed, lexicalTerms) + termOverlapBoost(indexed.chunk, lexicalTerms, SEARCH_FIELD_WEIGHTS);
      const trigramScore = scoreTrigram(indexed.chunk, indexed.trigramTerms, trigramTerms, trimmedQuery);
      const queryIsCode = queryKind === "trigram";
      const phraseBoost = exactPhraseBoost(
        indexed.chunk,
        trimmedQuery,
        queryIsCode,
        SEARCH_FIELD_WEIGHTS,
        flexiblePhraseMatch
      );

      const codeBoost =
        queryIsCode &&
        indexed.chunk.code_text.length > 0 &&
        includesPhraseFlexible(indexed.chunk.code_text, trimmedQuery, flexiblePhraseMatch)
          ? Math.min(0.35, SEARCH_FIELD_WEIGHTS.code * 0.6)
          : 0;

      scoredById.set(id, {
        chunk: indexed.chunk,
        lexicalScore,
        trigramScore,
        phraseBoost,
        codeBoost
      });
    }

    const lexicalRank = rankByScore(scoredById, (row) => row.lexicalScore + row.phraseBoost * 0.35 + row.codeBoost * 0.15);
    const trigramRank = rankByScore(scoredById, (row) => row.trigramScore + row.phraseBoost * 0.2 + row.codeBoost * 0.3);
    const scored: ScoredChunk[] = [];

    for (const [id, row] of scoredById.entries()) {
      let score = 0;

      if (decidedMode === "lexical") {
        score = row.lexicalScore + row.phraseBoost + row.codeBoost;
      } else if (decidedMode === "trigram") {
        score = row.trigramScore + row.phraseBoost * 0.5 + row.codeBoost;
      } else if (decidedMode === "exact") {
        score = isExactMatchCandidate(row.chunk, trimmedQuery, flexiblePhraseMatch) ? 1 + row.phraseBoost : 0;
      } else {
        const lexicalWeight = queryKind === "lexical" ? 0.7 : 0.35;
        const trigramWeight = queryKind === "lexical" ? 0.3 : 0.65;
        score =
          lexicalWeight * reciprocalRank(lexicalRank.get(id)) +
          trigramWeight * reciprocalRank(trigramRank.get(id)) +
          row.phraseBoost * 0.55 +
          row.codeBoost;
      }

      score += identifierFieldBoost(row.chunk, identifierTerms);
      score += requireSessionApiPenaltyOrBoost(row.chunk, identifierTerms);
      score += genericDocsPenalty(row.chunk, identifierTerms, lexicalTerms);
      score += queryIntentPathBoost(row.chunk, lexicalTerms, identifierTerms);
      score *= genericPathCapMultiplier(row.chunk, lexicalTerms, identifierTerms);

      if (score > 0) {
        scored.push({
          chunk: row.chunk,
          lexicalScore: row.lexicalScore,
          trigramScore: row.trigramScore,
          score
        });
      }
    }

    scored.sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) {
        return byScore;
      }

      const byPath = a.chunk.path.localeCompare(b.chunk.path);
      if (byPath !== 0) {
        return byPath;
      }

      return a.chunk.id.localeCompare(b.chunk.id);
    });
    const deduped = dedupeByPath(scored);
    return deduped.slice(offset, offset + limit).map((row) => ({
      id: row.chunk.id,
      path: row.chunk.path,
      title: row.chunk.title,
      headings: row.chunk.headings,
      score: round(row.score),
      lexicalScore: round(row.lexicalScore),
      trigramScore: round(row.trigramScore),
      snippet: snippetFor(row.chunk, trimmedQuery),
      debug: debug
        ? {
            decidedMode,
            queryClass: queryKind,
            phraseBoost: round(
              exactPhraseBoost(row.chunk, trimmedQuery, queryKind === "trigram", SEARCH_FIELD_WEIGHTS, flexiblePhraseMatch)
            ),
            codeBoost:
              queryKind === "trigram" && includesPhraseFlexible(row.chunk.code_text, trimmedQuery, flexiblePhraseMatch)
                ? Math.min(0.35, SEARCH_FIELD_WEIGHTS.code * 0.6)
                : 0,
            shortQueryFallback: shortQuery
          }
        : undefined
    }));
  }

  public getById(id: string): DocChunk | undefined {
    return this.byId.get(id);
  }

  public getContext(id: string, before: number, after: number, mode: ContextMode = "section"): DocChunk[] {
    const target = this.byId.get(id);
    if (!target) {
      return [];
    }

    const pageChunks = this.chunksByPath.get(target.path) ?? [];
    const targetHeadingKey = target.headings.join(" > ");
    const sectionChunks = pageChunks.filter((chunk) => chunk.headings.join(" > ") === targetHeadingKey);
    const scope = mode === "page" ? pageChunks : sectionChunks.length > 0 ? sectionChunks : pageChunks;

    const idx = scope.findIndex((c) => c.id === id);
    if (idx < 0) {
      return [];
    }

    const start = Math.max(0, idx - before);
    const end = Math.min(scope.length, idx + after + 1);
    return scope.slice(start, end);
  }

  public getPage(path: string): DocChunk[] {
    return this.chunksByPath.get(path) ?? [];
  }

  public listPages(prefix: string, limit: number): PageSummary[] {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const pages: PageSummary[] = [];

    for (const [path, chunks] of this.chunksByPath.entries()) {
      if (normalizedPrefix && !path.toLowerCase().includes(normalizedPrefix)) {
        continue;
      }

      pages.push({
        path,
        title: chunks[0]?.title ?? "Marten Docs",
        chunkCount: chunks.length
      });
    }

    pages.sort((a, b) => a.path.localeCompare(b.path));
    return pages.slice(0, limit);
  }

  public chunkCount(): number {
    return this.chunks.length;
  }

  public pageCount(): number {
    return this.chunksByPath.size;
  }

  private build(): void {
    for (const chunk of this.chunks) {
      const lexicalSource = `${chunk.title}\n${chunk.headings.join(" ")}\n${chunk.path}\n${chunk.body_text}`;
      const trigramSource = `${chunk.title}\n${chunk.headings.join(" ")}\n${chunk.path}\n${chunk.body_text}\n${chunk.code_text}`;

      const lexicalTerms = tokenize(lexicalSource);
      const trigramTerms = trigrams(trigramSource);

      this.preIndexed.set(chunk.id, {
        chunk,
        lexicalTerms,
        lexicalTermFrequency: countTerms(lexicalTerms),
        lexicalLength: lexicalTerms.length,
        trigramTerms
      });

      for (const term of lexicalTerms) {
        let posting = this.lexicalPostings.get(term);
        if (!posting) {
          posting = new Set<string>();
          this.lexicalPostings.set(term, posting);
        }
        posting.add(chunk.id);
      }

      for (const tri of trigramTerms) {
        let posting = this.trigramPostings.get(tri);
        if (!posting) {
          posting = new Set<string>();
          this.trigramPostings.set(tri, posting);
        }
        posting.add(chunk.id);
      }

    }

    let totalLength = 0;
    for (const indexed of this.preIndexed.values()) {
      totalLength += indexed.lexicalLength;
    }
    this.avgLexicalDocLength = this.preIndexed.size > 0 ? totalLength / this.preIndexed.size : 0;

    for (const [term, posting] of this.lexicalPostings.entries()) {
      this.lexicalDocFrequencies.set(term, posting.size);
    }

    this.buildChunksByPath();
  }

  public toPersistedState(): HybridIndexPersistedState {
    return {
      lexicalPostings: Array.from(this.lexicalPostings.entries()).map(([term, ids]) => [term, Array.from(ids)]),
      trigramPostings: Array.from(this.trigramPostings.entries()).map(([tri, ids]) => [tri, Array.from(ids)]),
      preIndexed: Array.from(this.preIndexed.values()).map((entry) => ({
        chunkId: entry.chunk.id,
        lexicalTerms: entry.lexicalTerms,
        lexicalTermFrequency: Array.from(entry.lexicalTermFrequency.entries()),
        lexicalLength: entry.lexicalLength,
        trigramTerms: entry.trigramTerms
      })),
      lexicalDocFrequencies: Array.from(this.lexicalDocFrequencies.entries()),
      avgLexicalDocLength: this.avgLexicalDocLength
    };
  }

  private hydrateFromPersistedState(state: HybridIndexPersistedState): boolean {
    try {
      for (const [term, ids] of state.lexicalPostings) {
        this.lexicalPostings.set(term, new Set(ids));
      }

      for (const [tri, ids] of state.trigramPostings) {
        this.trigramPostings.set(tri, new Set(ids));
      }

      for (const item of state.preIndexed) {
        const chunk = this.byId.get(item.chunkId);
        if (!chunk) {
          return false;
        }

        this.preIndexed.set(item.chunkId, {
          chunk,
          lexicalTerms: item.lexicalTerms,
          lexicalTermFrequency: new Map(item.lexicalTermFrequency),
          lexicalLength: item.lexicalLength,
          trigramTerms: item.trigramTerms
        });
      }

      for (const [term, df] of state.lexicalDocFrequencies) {
        this.lexicalDocFrequencies.set(term, df);
      }
      this.avgLexicalDocLength = state.avgLexicalDocLength;

      if (this.preIndexed.size !== this.chunks.length) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private buildChunksByPath(): void {
    for (const chunk of this.chunks) {
      let pathChunks = this.chunksByPath.get(chunk.path);
      if (!pathChunks) {
        pathChunks = [];
        this.chunksByPath.set(chunk.path, pathChunks);
      }
      pathChunks.push(chunk);
    }

    for (const chunks of this.chunksByPath.values()) {
      chunks.sort((a, b) => a.pageOrder - b.pageOrder);
    }
  }

  private scoreLexical(indexed: IndexedChunk, queryTerms: string[]): number {
    if (queryTerms.length === 0 || indexed.lexicalLength === 0) {
      return 0;
    }

    const uniqueQueryTerms = Array.from(new Set(queryTerms));
    const docCount = Math.max(this.preIndexed.size, 1);
    const k1 = 1.2;
    const b = 0.75;
    const denomLength = this.avgLexicalDocLength > 0 ? this.avgLexicalDocLength : indexed.lexicalLength;

    let score = 0;
    for (const term of uniqueQueryTerms) {
      const tf = indexed.lexicalTermFrequency.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }

      const df = this.lexicalDocFrequencies.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const tfWeight = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (indexed.lexicalLength / denomLength)));
      score += idf * tfWeight;
    }

    return score / Math.max(uniqueQueryTerms.length, 1);
  }

  private collectCandidates(postings: Map<string, Set<string>>, terms: string[]): Set<string> {
    const out = new Set<string>();
    for (const term of terms) {
      const ids = postings.get(term);
      if (!ids) {
        continue;
      }
      ids.forEach((id) => out.add(id));
    }
    return out;
  }
}

export function buildHybridIndexPersistedState(chunks: DocChunk[]): HybridIndexPersistedState {
  const index = new HybridIndex(chunks);
  return index.toPersistedState();
}

function classifyQuery(query: string): SearchMode {
  const terms = tokenize(query);
  const symbolHeavy = isSymbolHeavyQuery(query);
  const hasSessionApiHints = /\bIDocumentSession\b|\bIQuerySession\b|\bLoadAsync\b|\bQuery\s*<|\bStore\s*\(/i.test(query);
  if (hasSessionApiHints && terms.length >= 6) {
    return "lexical";
  }

  if (terms.length >= 10 && !symbolHeavy) {
    return "lexical";
  }

  const codeHints = /[<>{}().;:=\[\]`]/.test(query);
  const pascalOrCamel = /[A-Za-z]+[A-Z][A-Za-z0-9]*/.test(query);
  const hasNamespace = /[A-Za-z0-9_]+\.[A-Za-z0-9_]+/.test(query);
  const hasGeneric = /<[A-Za-z0-9_,\s]+>/.test(query);
  const hasMethodish = /\w+\s*\(.*\)/.test(query);

  if (codeHints || pascalOrCamel || hasNamespace || hasGeneric || hasMethodish) {
    return "trigram";
  }

  return "lexical";
}

function scoreTrigram(chunk: DocChunk, chunkTerms: string[], queryTerms: string[], query: string): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  const termSet = new Set(chunkTerms);
  let matched = 0;
  for (const t of queryTerms) {
    if (termSet.has(t)) {
      matched += 1;
    }
  }

  let score = matched / queryTerms.length;
  if (includesPhraseCaseInsensitive(chunk.code_text, query)) {
    score += Math.min(0.4, SEARCH_FIELD_WEIGHTS.code);
  }
  if (includesPhraseCaseInsensitive(chunk.raw_text, query)) {
    score += Math.min(0.2, SEARCH_FIELD_WEIGHTS.body);
  }

  return Math.min(score, 1.5);
}

function termOverlapBoost(
  chunk: DocChunk,
  queryTerms: string[],
  weights: { title: number; headings: number; path: number }
): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  const uniqueTerms = Array.from(new Set(queryTerms));
  const titleTerms = new Set(tokenize(chunk.title));
  const headingTerms = new Set(tokenize(chunk.headings.join(" ")));
  const pathTerms = new Set(tokenize(chunk.path));

  let titleMatches = 0;
  let headingMatches = 0;
  let pathMatches = 0;
  for (const term of uniqueTerms) {
    if (titleTerms.has(term)) {
      titleMatches += 1;
    }
    if (headingTerms.has(term)) {
      headingMatches += 1;
    }
    if (pathTerms.has(term)) {
      pathMatches += 1;
    }
  }

  const denom = Math.max(uniqueTerms.length, 1);
  const titleBoost = (titleMatches / denom) * Math.min(0.45, weights.title);
  const headingBoost = (headingMatches / denom) * Math.min(0.35, weights.headings);
  const pathBoost = (pathMatches / denom) * Math.min(0.3, weights.path);
  return titleBoost + headingBoost + pathBoost;
}

function snippetFor(chunk: DocChunk, query: string): string {
  const raw = normalizeWhitespace(chunk.raw_text);
  if (!query.trim()) {
    return raw.slice(0, 200);
  }

  const lowerRaw = raw.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerRaw.indexOf(lowerQuery);
  if (idx < 0) {
    return raw.slice(0, 200);
  }

  const start = Math.max(0, idx - 80);
  const end = Math.min(raw.length, idx + lowerQuery.length + 120);
  return raw.slice(start, end);
}

function round(num: number): number {
  return Math.round(num * 1000) / 1000;
}

function countTerms(terms: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const term of terms) {
    out.set(term, (out.get(term) ?? 0) + 1);
  }
  return out;
}

function isShortQuery(query: string): boolean {
  if (!query) {
    return false;
  }

  if (query.length <= 3) {
    return true;
  }

  const terms = tokenize(query);
  return terms.length === 1 && terms[0].length <= 3;
}

function isSymbolHeavyQuery(query: string): boolean {
  const symbols = query.replace(/[A-Za-z0-9\s]/g, "");
  return symbols.length >= 2;
}

function isExactMatchCandidate(chunk: DocChunk, query: string, flexibleMatch: boolean): boolean {
  return (
    includesPhraseFlexible(chunk.title, query, flexibleMatch) ||
    includesPhraseFlexible(chunk.path, query, flexibleMatch) ||
    chunk.headings.some((heading) => includesPhraseFlexible(heading, query, flexibleMatch)) ||
    includesPhraseFlexible(chunk.raw_text, query, flexibleMatch)
  );
}

function exactPhraseBoost(
  chunk: DocChunk,
  query: string,
  queryIsCode: boolean,
  weights: { title: number; headings: number; path: number; body: number; code: number },
  flexibleMatch: boolean
): number {
  if (!query) {
    return 0;
  }

  let boost = 0;
  if (includesPhraseFlexible(chunk.title, query, flexibleMatch)) {
    boost += weights.title;
  }
  if (includesPhraseFlexible(chunk.path, query, flexibleMatch)) {
    boost += weights.path;
  }
  if (chunk.headings.some((heading) => includesPhraseFlexible(heading, query, flexibleMatch))) {
    boost += weights.headings;
  }
  if (includesPhraseFlexible(chunk.body_text, query, flexibleMatch)) {
    boost += weights.body;
  }
  if (queryIsCode && includesPhraseFlexible(chunk.code_text, query, flexibleMatch)) {
    boost += weights.code;
  }

  return Math.min(boost, 1);
}

function includesPhraseFlexible(haystack: string, query: string, flexibleMatch: boolean): boolean {
  if (includesPhraseCaseInsensitive(haystack, query)) {
    return true;
  }

  if (!flexibleMatch) {
    return false;
  }

  const normalizedHaystack = normalizeSymbolic(haystack);
  const normalizedQuery = normalizeSymbolic(query);
  if (!normalizedHaystack || !normalizedQuery) {
    return false;
  }

  return normalizedHaystack.includes(normalizedQuery);
}

function normalizeSymbolic(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildQueryProfile(query: string): QueryProfile {
  const raw = query.trim();
  const cleaned = stripQueryNoise(raw);
  const lexicalTerms = tokenize(cleaned);
  const trigramTerms = trigrams(cleaned);
  const identifierTerms = extractIdentifierTerms(raw);
  return {
    raw,
    lexicalTerms,
    trigramTerms,
    identifierTerms,
    queryClass: classifyQuery(raw),
    symbolHeavy: isSymbolHeavyQuery(raw),
    shortQuery: isShortQuery(raw)
  };
}

function stripQueryNoise(query: string): string {
  const noise = new Set([
    "in",
    "review",
    "improvements",
    "improvement",
    "please",
    "and",
    "for",
    "the",
    "this",
    "with",
    "usage"
  ]);

  const terms = tokenize(query).filter((term) => !noise.has(term));
  return terms.join(" ");
}

function extractIdentifierTerms(query: string): string[] {
  const patterns = query.match(/[A-Za-z_][A-Za-z0-9_<>()\/.]*/g) ?? [];
  const out = new Set<string>();
  for (const token of patterns) {
    if (/^[A-Z]/.test(token) || token.includes(".") || token.includes("<") || token.includes("(")) {
      tokenize(token).forEach((term) => out.add(term));
      out.add(token.toLowerCase());
    }
  }
  return Array.from(out);
}

function rankByScore<T>(
  scoredById: Map<string, T>,
  scorer: (value: T) => number
): Map<string, number> {
  const rows = Array.from(scoredById.entries()).map(([id, value]) => ({ id, score: scorer(value) }));
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const rank = new Map<string, number>();
  rows.forEach((row, index) => rank.set(row.id, index + 1));
  return rank;
}

function reciprocalRank(rank: number | undefined): number {
  if (!rank) {
    return 0;
  }
  const k = 60;
  return 1 / (k + rank);
}

function identifierFieldBoost(chunk: DocChunk, identifierTerms: string[]): number {
  if (identifierTerms.length === 0) {
    return 0;
  }

  const haystacks = [chunk.title, chunk.path, chunk.headings.join(" "), chunk.code_text, chunk.raw_text];
  let matches = 0;
  for (const term of identifierTerms) {
    if (haystacks.some((field) => field.toLowerCase().includes(term))) {
      matches += 1;
    }
  }

  return Math.min(0.5, (matches / identifierTerms.length) * 0.4);
}

function requireSessionApiPenaltyOrBoost(chunk: DocChunk, identifierTerms: string[]): number {
  const hasSessionIntent = identifierTerms.some((term) =>
    ["idocumentsession", "iquerysession", "query", "loadasync"].includes(term)
  );
  if (!hasSessionIntent) {
    return 0;
  }

  const hasSessionHit =
    includesPhraseCaseInsensitive(chunk.raw_text, "IDocumentSession") ||
    includesPhraseCaseInsensitive(chunk.raw_text, "IQuerySession") ||
    includesPhraseCaseInsensitive(chunk.raw_text, "Query<") ||
    includesPhraseCaseInsensitive(chunk.raw_text, "LoadAsync");

  return hasSessionHit ? 0.45 : -0.32;
}

function genericDocsPenalty(chunk: DocChunk, identifierTerms: string[], lexicalTerms: string[]): number {
  const path = chunk.path.toLowerCase();
  const likelyGeneric =
    path.includes("/getting-started") ||
    path.includes("/migration-guide") ||
    path.includes("/configuration/hostbuilder");

  if (!likelyGeneric) {
    return 0;
  }

  const hasStrongIdentifierHit = identifierTerms.some((term) => chunk.raw_text.toLowerCase().includes(term));
  const hasTopicFocus = lexicalTerms.some((term) => chunk.path.toLowerCase().includes(term));
  if (hasStrongIdentifierHit || hasTopicFocus) {
    return 0;
  }

  return identifierTerms.length > 0 ? -0.45 : -0.22;
}

function dedupeByPath(rows: ScoredChunk[]): ScoredChunk[] {
  const seen = new Set<string>();
  const out: ScoredChunk[] = [];
  for (const row of rows) {
    if (seen.has(row.chunk.path)) {
      continue;
    }
    seen.add(row.chunk.path);
    out.push(row);
  }
  return out;
}

function queryIntentPathBoost(chunk: DocChunk, lexicalTerms: string[], identifierTerms: string[]): number {
  const path = chunk.path.toLowerCase();
  const hasSessionIntent = hasAny(identifierTerms, ["idocumentsession", "iquerysession", "query", "loadasync"]);
  const hasProjectionIntent = hasAny(lexicalTerms, ["projection", "projections", "inline", "daemon"]);
  const hasIndexIntent = hasAny(lexicalTerms, ["index", "indexing", "duplicated", "compiled"]);
  const hasFetchLatestIntent = hasAny(lexicalTerms, ["fetchlatest", "fetch", "latest"]);
  const hasReadAggregateIntent = hasAny(lexicalTerms, ["read", "aggregate", "aggregates"]);
  const hasNaturalKeyIntent = hasAny(lexicalTerms, ["natural", "key", "keys"]);

  let boost = 0;
  if (hasSessionIntent && path.includes("/documents/sessions")) {
    boost += 0.7;
  }
  if (hasSessionIntent && path.includes("/documents/querying")) {
    boost += 0.25;
  }
  if (hasProjectionIntent && path.includes("/events/projections")) {
    boost += 0.2;
  }
  if (hasIndexIntent && path.includes("/documents/indexing")) {
    boost += 0.2;
  }
  if (hasFetchLatestIntent && hasReadAggregateIntent && path.includes("/events/projections/read-aggregates")) {
    boost += 0.55;
  }
  if (hasFetchLatestIntent && hasNaturalKeyIntent && path.includes("/events/natural-keys")) {
    boost += 0.55;
  }

  return boost;
}

function genericPathCapMultiplier(chunk: DocChunk, lexicalTerms: string[], identifierTerms: string[]): number {
  const path = chunk.path.toLowerCase();
  const generic =
    path.includes("/getting-started") ||
    path.includes("/migration-guide") ||
    path.includes("/configuration/hostbuilder");
  if (!generic) {
    return 1;
  }

  const hasSessionIntent = hasAny(identifierTerms, ["idocumentsession", "iquerysession", "query", "loadasync"]);
  const hasOptimizationIntent = hasAny(lexicalTerms, ["improvement", "improvements", "index", "projection", "query"]);
  if (hasSessionIntent && hasOptimizationIntent) {
    return 0.62;
  }

  return 1;
}

function hasAny(haystack: string[], needles: string[]): boolean {
  const set = new Set(haystack.map((value) => value.toLowerCase()));
  return needles.some((needle) => set.has(needle));
}
