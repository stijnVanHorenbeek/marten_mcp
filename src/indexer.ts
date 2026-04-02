import type { DocChunk, SearchMode, SearchResult } from "./types.js";
import {
  includesPhraseCaseInsensitive,
  normalizeWhitespace,
  tokenize,
  trigrams
} from "./util.js";

interface IndexedChunk {
  chunk: DocChunk;
  lexicalTerms: string[];
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

  public constructor(chunks: DocChunk[]) {
    this.chunks = chunks;
    this.byId = new Map(chunks.map((x) => [x.id, x]));
    this.chunksByPath = new Map();
    this.lexicalPostings = new Map();
    this.trigramPostings = new Map();
    this.preIndexed = new Map();
    this.build();
  }

  public search(query: string, limit: number, mode: SearchMode = "auto"): SearchResult[] {
    const trimmedQuery = query.trim();
    const shortQuery = isShortQuery(trimmedQuery);
    const queryKind = classifyQuery(trimmedQuery);
    const decidedMode = mode === "auto" ? (shortQuery ? "exact" : queryKind) : mode;
    const lexicalTerms = tokenize(trimmedQuery);
    const trigramTerms = trigrams(trimmedQuery);

    const lexicalCandidates = this.collectCandidates(this.lexicalPostings, lexicalTerms);
    const trigramCandidates = this.collectCandidates(this.trigramPostings, trigramTerms);
    const candidateIds = new Set<string>();

    if (decidedMode === "lexical") {
      lexicalCandidates.forEach((id) => candidateIds.add(id));
    } else if (decidedMode === "trigram") {
      trigramCandidates.forEach((id) => candidateIds.add(id));
    } else if (decidedMode === "exact") {
      this.chunks.forEach((chunk) => {
        if (isExactMatchCandidate(chunk, trimmedQuery)) {
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

      const lexicalScore = scoreLexical(indexed.chunk, indexed.lexicalTerms, lexicalTerms, trimmedQuery);
      const trigramScore = scoreTrigram(indexed.chunk, indexed.trigramTerms, trigramTerms, trimmedQuery);
      const queryIsCode = queryKind === "trigram";
      const phraseBoost = exactPhraseBoost(indexed.chunk, trimmedQuery, queryIsCode);

      let score = lexicalScore * 0.65 + trigramScore * 0.35;
      if (decidedMode === "lexical") {
        score = lexicalScore;
      } else if (decidedMode === "trigram") {
        score = trigramScore;
      } else if (decidedMode === "exact") {
        score = isExactMatchCandidate(indexed.chunk, trimmedQuery) ? 1 + phraseBoost : 0;
      } else {
        score += phraseBoost;
      }

      if (queryIsCode && indexed.chunk.code_text.length > 0 && includesPhraseCaseInsensitive(indexed.chunk.code_text, trimmedQuery)) {
        score += 0.2;
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

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((row) => ({
      id: row.chunk.id,
      path: row.chunk.path,
      title: row.chunk.title,
      headings: row.chunk.headings,
      score: round(row.score),
      lexicalScore: round(row.lexicalScore),
      trigramScore: round(row.trigramScore),
      snippet: snippetFor(row.chunk, trimmedQuery)
    }));
  }

  public getById(id: string): DocChunk | undefined {
    return this.byId.get(id);
  }

  public getContext(id: string, before: number, after: number): DocChunk[] {
    const target = this.byId.get(id);
    if (!target) {
      return [];
    }

    const pageChunks = this.chunksByPath.get(target.path) ?? [];
    const targetHeadingKey = target.headings.join(" > ");
    const sectionChunks = pageChunks.filter((chunk) => chunk.headings.join(" > ") === targetHeadingKey);
    const scope = sectionChunks.length > 0 ? sectionChunks : pageChunks;

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

    for (const chunks of this.chunksByPath.values()) {
      chunks.sort((a, b) => a.pageOrder - b.pageOrder);
    }
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

function scoreLexical(chunk: DocChunk, chunkTerms: string[], queryTerms: string[], query: string): number {
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
  if (includesPhraseCaseInsensitive(chunk.title, query)) {
    score += 0.25;
  }
  if (includesPhraseCaseInsensitive(chunk.path, query)) {
    score += 0.2;
  }
  if (chunk.headings.some((h) => includesPhraseCaseInsensitive(h, query))) {
    score += 0.2;
  }
  if (includesPhraseCaseInsensitive(chunk.body_text, query)) {
    score += 0.15;
  }

  return Math.min(score, 1.5);
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
    score += 0.3;
  }
  if (includesPhraseCaseInsensitive(chunk.raw_text, query)) {
    score += 0.15;
  }

  return Math.min(score, 1.5);
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

function isExactMatchCandidate(chunk: DocChunk, query: string): boolean {
  return (
    includesPhraseCaseInsensitive(chunk.title, query) ||
    includesPhraseCaseInsensitive(chunk.path, query) ||
    chunk.headings.some((heading) => includesPhraseCaseInsensitive(heading, query)) ||
    includesPhraseCaseInsensitive(chunk.raw_text, query)
  );
}

function exactPhraseBoost(chunk: DocChunk, query: string, queryIsCode: boolean): number {
  if (!query) {
    return 0;
  }

  let boost = 0;
  if (includesPhraseCaseInsensitive(chunk.title, query)) {
    boost += 0.4;
  }
  if (includesPhraseCaseInsensitive(chunk.path, query)) {
    boost += 0.25;
  }
  if (chunk.headings.some((heading) => includesPhraseCaseInsensitive(heading, query))) {
    boost += 0.3;
  }
  if (includesPhraseCaseInsensitive(chunk.body_text, query)) {
    boost += 0.15;
  }
  if (queryIsCode && includesPhraseCaseInsensitive(chunk.code_text, query)) {
    boost += 0.35;
  }

  return Math.min(boost, 1);
}
