import fs from "node:fs/promises";
import path from "node:path";
import { parseTelemetryLines, tsMs, type TelemetryEnvelope, type TelemetryEvent } from "./lib/telemetry-events.ts";

export interface CliOptions {
  input: string;
  output: string;
  minSearches: number;
  minSelections: number;
  windowMs: number;
  minShare: number;
  clusterSimilarity: number;
  clusterMinSharedTerms: number;
}

interface SearchEvent {
  processId: number;
  tsMs: number;
  seq: number;
  clusterId: string;
  topResultPaths: Set<string>;
}

interface QueryStats {
  clusterId: string;
  queryCounts: Map<string, number>;
  searches: number;
  top1PathCounts: Map<string, number>;
  selectedPathCounts: Map<string, number>;
}

interface QueryCluster {
  id: string;
  terms: Set<string>;
}

interface CountEntry {
  key: string;
  count: number;
}

export interface MinedCandidate {
  query: string;
  queryVariants?: Array<{ query: string; count: number }>;
  searches: number;
  selections: number;
  top1Paths: Array<{ path: string; count: number; share: number }>;
  selectedPaths: Array<{ path: string; count: number; share: number }>;
  suggestedExpected: {
    pathIncludes?: string;
    pathAnyOf?: string[];
  };
}

interface MineOutput {
  generatedAt: string;
  options: CliOptions;
  candidates: MinedCandidate[];
}

interface MineRunResult {
  parsedEvents: number;
  minedCandidates: number;
  outputPath: string;
}

export async function mineTelemetry(options: CliOptions): Promise<MineRunResult> {
  const lines = (await fs.readFile(options.input, "utf8")).split(/\r?\n/);
  const events = parseTelemetryLines(lines);

  const recentSearches = new Map<number, SearchEvent[]>();
  const statsByCluster = new Map<string, QueryStats>();
  const clusters: QueryCluster[] = [];

  for (const envelope of events) {
    const event = envelope.event;
    if (event.tool === "search_docs") {
      const rawQueryTerms = Array.isArray(event.queryTerms) ? event.queryTerms : [];
      const queryTerms = canonicalTerms(rawQueryTerms.join(" "));
      const representativeQuery = rawQueryTerms.join(" ").trim();
      const clusterId = findOrCreateClusterId(representativeQuery, queryTerms, clusters, options);
      const stats = getOrCreateStats(statsByCluster, clusterId, representativeQuery);
      stats.searches += 1;
      stats.queryCounts.set(representativeQuery, (stats.queryCounts.get(representativeQuery) ?? 0) + 1);
      const topPaths = Array.isArray(event.topResultPaths) ? event.topResultPaths : [];
      const top1 = topPaths[0];
      if (top1) {
        stats.top1PathCounts.set(top1, (stats.top1PathCounts.get(top1) ?? 0) + 1);
      }

      const list = recentSearches.get(event.processId) ?? [];
      list.push({
        processId: event.processId,
        tsMs: tsMs(event.ts),
        seq: event.seq,
        clusterId,
        topResultPaths: new Set(topPaths)
      });
      if (list.length > 40) {
        list.shift();
      }
      recentSearches.set(event.processId, list);
      continue;
    }

    const selectedPaths = selectedPathsFromReadEvent(event);
    if (selectedPaths.length === 0) {
      continue;
    }

    const priorSearch = findAttributionSearch(
      recentSearches.get(event.processId) ?? [],
      selectedPaths,
      tsMs(event.ts),
      event.seq,
      options.windowMs
    );
    if (!priorSearch) {
      continue;
    }

    const stats = getOrCreateStats(statsByCluster, priorSearch.clusterId, priorSearch.clusterId);
    for (const selectedPath of selectedPaths) {
      stats.selectedPathCounts.set(selectedPath, (stats.selectedPathCounts.get(selectedPath) ?? 0) + 1);
    }
  }

  const candidates: MinedCandidate[] = [];
  for (const [clusterId, stats] of statsByCluster.entries()) {
    if (stats.searches < options.minSearches) {
      continue;
    }

    const selectedEntries = mapCounts(stats.selectedPathCounts);
    const selectedTotal = selectedEntries.reduce((sum, item) => sum + item.count, 0);
    if (selectedTotal < options.minSelections) {
      continue;
    }

    const top1Entries = mapCounts(stats.top1PathCounts);
    const expected = buildSuggestedExpected(selectedEntries, selectedTotal, options.minShare);
    const queryVariants = mapCounts(stats.queryCounts);
    const representativeQuery = queryVariants[0]?.key ?? clusterId;
    candidates.push({
      query: representativeQuery,
      queryVariants: queryVariants.map((row) => ({ query: row.key, count: row.count })),
      searches: stats.searches,
      selections: selectedTotal,
      top1Paths: withShare(top1Entries),
      selectedPaths: withShare(selectedEntries),
      suggestedExpected: expected
    });
  }

  candidates.sort((a, b) => {
    if (b.searches !== a.searches) {
      return b.searches - a.searches;
    }
    return b.selections - a.selections;
  });

  const output: MineOutput = {
    generatedAt: new Date().toISOString(),
    options,
    candidates
  };

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  return {
    parsedEvents: events.length,
    minedCandidates: candidates.length,
    outputPath: options.output
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await mineTelemetry(options);

  process.stdout.write(`Telemetry lines parsed: ${result.parsedEvents}\n`);
  process.stdout.write(`Mined candidates: ${result.minedCandidates}\n`);
  process.stdout.write(`Output: ${result.outputPath}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const defaults: CliOptions = {
    input: process.env.MARTEN_MCP_TELEMETRY_PATH
      ? path.resolve(process.env.MARTEN_MCP_TELEMETRY_PATH)
      : path.join(process.cwd(), "eval", "telemetry", "mcp-telemetry.jsonl"),
    output: path.join(process.cwd(), "eval", "generated", "mined-candidates.json"),
    minSearches: 3,
    minSelections: 2,
    windowMs: 120000,
    minShare: 0.25,
    clusterSimilarity: 0.6,
    clusterMinSharedTerms: 2
  };

  const out = { ...defaults };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--input" && next) {
      out.input = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--output" && next) {
      out.output = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--min-searches" && next) {
      out.minSearches = toPositiveInt(next, out.minSearches);
      i += 1;
      continue;
    }
    if (arg === "--min-selections" && next) {
      out.minSelections = toPositiveInt(next, out.minSelections);
      i += 1;
      continue;
    }
    if (arg === "--window-ms" && next) {
      out.windowMs = toPositiveInt(next, out.windowMs);
      i += 1;
      continue;
    }
    if (arg === "--min-share" && next) {
      out.minShare = toFraction(next, out.minShare);
      i += 1;
      continue;
    }
    if (arg === "--cluster-similarity" && next) {
      out.clusterSimilarity = toFraction(next, out.clusterSimilarity);
      i += 1;
      continue;
    }
    if (arg === "--cluster-min-shared-terms" && next) {
      out.clusterMinSharedTerms = toPositiveInt(next, out.clusterMinSharedTerms);
      i += 1;
      continue;
    }
  }

  return out;
}

function selectedPathsFromReadEvent(event: TelemetryEvent): string[] {
  if (event.tool === "read_section") {
    return event.path ? [event.path] : [];
  }
  if (event.tool === "read_context") {
    if (Array.isArray(event.chunkPaths) && event.chunkPaths.length > 0) {
      return event.chunkPaths;
    }
    return event.paths ?? [];
  }
  if (event.tool === "search_within_page") {
    return event.path ? [event.path] : [];
  }
  return [];
}

function findAttributionSearch(
  candidates: SearchEvent[],
  selectedPaths: string[],
  ts: number,
  seq: number,
  maxWindowMs: number
): SearchEvent | null {
  const selectedSet = new Set(selectedPaths.map((pathValue) => pathValue.toLowerCase()));

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (candidate.seq > seq) {
      continue;
    }

    const delta = ts - candidate.tsMs;
    if (delta < 0 || delta > maxWindowMs) {
      continue;
    }

    for (const candidatePath of candidate.topResultPaths) {
      if (selectedSet.has(candidatePath.toLowerCase())) {
        return candidate;
      }
    }
  }

  return findNearestSearch(candidates, ts, seq, maxWindowMs);
}

function findNearestSearch(candidates: SearchEvent[], ts: number, seq: number, maxWindowMs: number): SearchEvent | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (candidate.seq > seq) {
      continue;
    }
    const delta = ts - candidate.tsMs;
    if (delta < 0 || delta > maxWindowMs) {
      continue;
    }
    return candidate;
  }
  return null;
}

function getOrCreateStats(map: Map<string, QueryStats>, clusterId: string, queryForInit: string): QueryStats {
  const existing = map.get(clusterId);
  if (existing) {
    return existing;
  }

  const created: QueryStats = {
    clusterId,
    queryCounts: new Map([[queryForInit, 0]]),
    searches: 0,
    top1PathCounts: new Map(),
    selectedPathCounts: new Map()
  };
  map.set(clusterId, created);
  return created;
}

function findOrCreateClusterId(
  query: string,
  queryTerms: Set<string>,
  clusters: QueryCluster[],
  options: Pick<CliOptions, "clusterSimilarity" | "clusterMinSharedTerms">
): string {
  let best: { cluster: QueryCluster; similarity: number; sharedTerms: number } | null = null;

  for (const cluster of clusters) {
    const sharedTerms = intersectionSize(queryTerms, cluster.terms);
    if (sharedTerms < options.clusterMinSharedTerms) {
      continue;
    }

    const similarity = jaccard(queryTerms, cluster.terms);
    if (similarity < options.clusterSimilarity) {
      continue;
    }

    if (!best || similarity > best.similarity) {
      best = { cluster, similarity, sharedTerms };
    }
  }

  if (best) {
    for (const term of queryTerms) {
      best.cluster.terms.add(term);
    }
    return best.cluster.id;
  }

  const id = clusterIdForQuery(query);
  clusters.push({
    id,
    terms: new Set(queryTerms)
  });
  return id;
}

function canonicalTerms(query: string): Set<string> {
  const noise = new Set(["marten", "review", "usage", "improvement", "improvements", "for", "and", "the"]);
  const terms = splitQueryTerms(query)
    .toLowerCase()
    .split(/\s+/)
    .map((term) => normalizeQueryTerm(term))
    .filter((term) => term.length >= 3 && !noise.has(term));
  return new Set(terms);
}

function splitQueryTerms(query: string): string {
  return query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/["'`.,;:!?(){}\[\]<>/\\|-]+/g, " ");
}

function normalizeQueryTerm(term: string): string {
  if (term.endsWith("ies") && term.length > 4) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.endsWith("sses") || term.endsWith("xes") || term.endsWith("ches") || term.endsWith("shes")) {
    return term.slice(0, -2);
  }
  if (term.endsWith("s") && !term.endsWith("ss") && term.length > 3) {
    return term.slice(0, -1);
  }
  return term;
}

function clusterIdForQuery(query: string): string {
  return query.trim().toLowerCase();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersect = intersectionSize(a, b);
  const union = a.size + b.size - intersect;
  if (union === 0) {
    return 0;
  }
  return intersect / union;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) {
      count += 1;
    }
  }
  return count;
}

function mapCounts(counts: Map<string, number>): CountEntry[] {
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function withShare(entries: CountEntry[]): Array<{ path: string; count: number; share: number }> {
  const total = entries.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) {
    return [];
  }

  return entries.map((item) => ({
    path: item.key,
    count: item.count,
    share: round(item.count / total)
  }));
}

function buildSuggestedExpected(
  selectedEntries: CountEntry[],
  selectedTotal: number,
  minShare: number
): { pathIncludes?: string; pathAnyOf?: string[] } {
  if (selectedEntries.length === 0 || selectedTotal === 0) {
    return {};
  }

  const candidates = selectedEntries.filter((item) => item.count / selectedTotal >= minShare).map((item) => item.key);
  if (candidates.length <= 1) {
    return { pathIncludes: selectedEntries[0]?.key };
  }

  return { pathAnyOf: candidates };
}

function toPositiveInt(input: string, fallback: number): number {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toFraction(input: string, fallback: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

if (import.meta.main) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[mine-eval] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
