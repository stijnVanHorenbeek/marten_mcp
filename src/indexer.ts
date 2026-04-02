import type { ContextMode, DocChunk, PageSummary, SearchMode, SearchResult } from "./types.js";
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

export class HybridIndex {
  private readonly chunks: DocChunk[];
  private readonly byId: Map<string, DocChunk>;
  private readonly chunksByPath: Map<string, DocChunk[]>;
  private readonly lexicalPostings: Map<string, Set<string>>;
  private readonly trigramPostings: Map<string, Set<string>>;
  private readonly preIndexed: Map<string, IndexedChunk>;
  private readonly lexicalDocFrequencies: Map<string, number>;
  private avgLexicalDocLength: number;

  public constructor(chunks: DocChunk[]) {
    this.chunks = chunks;
    this.byId = new Map(chunks.map((x) => [x.id, x]));
    this.chunksByPath = new Map();
    this.lexicalPostings = new Map();
    this.trigramPostings = new Map();
    this.preIndexed = new Map();
    this.lexicalDocFrequencies = new Map();
    this.avgLexicalDocLength = 0;
    this.build();
  }

  public search(query: string, limit: number, mode: SearchMode = "auto", debug = false, offset = 0): SearchResult[] {
    const trimmedQuery = query.trim();
    const shortQuery = isShortQuery(trimmedQuery);
    const symbolHeavy = isSymbolHeavyQuery(trimmedQuery);
    const flexiblePhraseMatch = symbolHeavy || shortQuery;
    const queryKind = classifyQuery(trimmedQuery);
    const useHybridAuto = mode === "auto" && !shortQuery;
    const decidedMode = mode === "auto" ? (shortQuery ? "exact" : queryKind) : mode;
    const lexicalTerms = tokenize(trimmedQuery);
    const trigramTerms = trigrams(trimmedQuery);

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

    const scored: ScoredChunk[] = [];
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

      let score = lexicalScore * 0.65 + trigramScore * 0.35;
      if (useHybridAuto) {
        score =
          queryKind === "lexical"
            ? lexicalScore * 0.8 + trigramScore * 0.2
            : lexicalScore * 0.35 + trigramScore * 0.65;
      } else if (decidedMode === "lexical") {
        score = lexicalScore;
      } else if (decidedMode === "trigram") {
        score = trigramScore;
      } else if (decidedMode === "exact") {
        score = isExactMatchCandidate(indexed.chunk, trimmedQuery, flexiblePhraseMatch) ? 1 + phraseBoost : 0;
      } else {
        score += phraseBoost;
      }

      const codeBoost =
        queryIsCode &&
        indexed.chunk.code_text.length > 0 &&
        includesPhraseFlexible(indexed.chunk.code_text, trimmedQuery, flexiblePhraseMatch)
          ? Math.min(0.35, SEARCH_FIELD_WEIGHTS.code * 0.6)
          : 0;
      if (codeBoost > 0) {
        score += codeBoost;
      }

      if (score > 0) {
        scored.push({
          chunk: indexed.chunk,
          lexicalScore,
          trigramScore,
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
    return scored.slice(offset, offset + limit).map((row) => ({
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
      const lexicalSource = `${chunk.title}\n${chunk.headings.join(" ")}\n${chunk.body_text}`;
      const trigramSource = `${chunk.title}\n${chunk.headings.join(" ")}\n${chunk.raw_text}`;

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

      let pathChunks = this.chunksByPath.get(chunk.path);
      if (!pathChunks) {
        pathChunks = [];
        this.chunksByPath.set(chunk.path, pathChunks);
      }
      pathChunks.push(chunk);
    }

    let totalLength = 0;
    for (const indexed of this.preIndexed.values()) {
      totalLength += indexed.lexicalLength;
    }
    this.avgLexicalDocLength = this.preIndexed.size > 0 ? totalLength / this.preIndexed.size : 0;

    for (const [term, posting] of this.lexicalPostings.entries()) {
      this.lexicalDocFrequencies.set(term, posting.size);
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

function classifyQuery(query: string): SearchMode {
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
