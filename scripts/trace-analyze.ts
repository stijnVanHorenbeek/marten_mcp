import { readTelemetryFile, selectTrace, type TelemetryEnvelope } from "./lib/telemetry-events.ts";
import { resolveTelemetryInputFile } from "./lib/telemetry-paths.ts";

export interface AnalyzeOptions {
  input?: string;
  processId?: number;
  traceId?: string;
  latest: boolean;
}

export interface TraceAnalysis {
  processId: number | null;
  totalSteps: number;
  flags: string[];
}

export async function analyzeTraceFromOptions(options: AnalyzeOptions): Promise<TraceAnalysis> {
  const input = await resolveTelemetryInputFile({
    explicitInput: options.input,
    latest: options.latest
  });
  const envelopes = await readTelemetryFile(input.filePath);
  const selected = selectTrace(envelopes, {
    processId: options.processId,
    traceId: options.traceId,
    latest: options.latest
  });
  return analyzeTrace(selected);
}

export function analyzeTrace(trace: TelemetryEnvelope[]): TraceAnalysis {
  if (trace.length === 0) {
    return {
      processId: null,
      totalSteps: 0,
      flags: ["empty_trace"]
    };
  }

  const flags = new Set<string>();
  const events = trace.map((row) => row.event);
  const searchDocs = events.filter((event): event is Extract<TelemetryEnvelope["event"], { tool: "search_docs" }> => event.tool === "search_docs");
  const searchWithin = events.filter((event) => event.tool === "search_within_page");
  const readSections = events.filter((event) => event.tool === "read_section");
  const readContexts = events.filter((event) => event.tool === "read_context");
  const listHeadings = events.filter((event) => event.tool === "list_headings");

  if (searchDocs.length >= 5) {
    flags.add("too_many_global_searches");
  }

  if (readSections.length > 0 && searchWithin.length === 0 && listHeadings.length === 0) {
    flags.add("skipped_local_narrowing");
  }

  if (readSections.some((event) => event.found) && readContexts.length === 0) {
    flags.add("no_read_context_after_relevant_chunk");
  }

  if (hasRepeatedSimilarSearches(searchDocs)) {
    flags.add("repeated_similar_searches");
  }

  if (hasGlobalSearchDrift(searchDocs)) {
    flags.add("repeated_global_search_drift");
  }

  if (hasSearchAgainAfterGoodHit(events)) {
    flags.add("searched_again_after_good_hit");
  }

  if (hasCodeOnlyReadThenResearch(events)) {
    flags.add("code_only_read_then_research");
  }

  if (readSections.some((event) => event.path) && searchWithin.length === 0) {
    const searchedPathSet = new Set(
      searchDocs
        .flatMap((event) => event.topResultPaths ?? event.topResults?.map((row) => row.path) ?? [])
        .map((value) => value.toLowerCase())
    );
    const matchedRead = readSections.some((event) => {
      const readPath = event.path?.toLowerCase();
      return !!readPath && searchedPathSet.has(readPath);
    });
    if (matchedRead) {
      flags.add("no_search_within_page_after_relevant_page");
    }
  }

  return {
    processId: events[0]?.processId ?? null,
    totalSteps: trace.length,
    flags: Array.from(flags).sort()
  };
}

function hasRepeatedSimilarSearches(
  searches: Array<Extract<TelemetryEnvelope["event"], { tool: "search_docs" }>>
): boolean {
  if (searches.length < 3) {
    return false;
  }

  let repeated = 0;
  for (let i = 1; i < searches.length; i++) {
    const prev = new Set((searches[i - 1]?.queryTerms ?? []).map((term) => term.toLowerCase()));
    const current = new Set((searches[i]?.queryTerms ?? []).map((term) => term.toLowerCase()));
    const similarity = jaccard(prev, current);
    if (similarity >= 0.75) {
      repeated += 1;
    }
  }

  return repeated >= 2;
}

function hasGlobalSearchDrift(searches: Array<Extract<TelemetryEnvelope["event"], { tool: "search_docs" }>>): boolean {
  if (searches.length < 3) {
    return false;
  }

  const topPaths = searches
    .map((search) => (search.topResultPaths && search.topResultPaths[0]) || search.topResults?.[0]?.path || "")
    .filter((value) => value.length > 0);
  if (topPaths.length < 3) {
    return false;
  }

  return new Set(topPaths.map((value) => value.toLowerCase())).size >= 3;
}

function hasSearchAgainAfterGoodHit(events: TelemetryEnvelope["event"][]): boolean {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.tool !== "search_docs") {
      continue;
    }

    const topPaths = event.topResultPaths ?? event.topResults?.map((row) => row.path) ?? [];
    const next = events.slice(i + 1, i + 4);
    const hadRead = next.some((candidate) => candidate.tool === "read_section" && !!candidate.path && topPaths.includes(candidate.path));
    const searchedAgain = events.slice(i + 1).some((candidate) => candidate.tool === "search_docs");
    if (hadRead && searchedAgain) {
      return true;
    }
  }

  return false;
}

function hasCodeOnlyReadThenResearch(events: TelemetryEnvelope["event"][]): boolean {
  const firstSearchAfterRead = events.findIndex((event, index) => {
    if (event.tool !== "search_docs") {
      return false;
    }
    return events.slice(0, index).some((prior) => prior.tool === "read_section");
  });
  if (firstSearchAfterRead < 0) {
    return false;
  }

  const readsBefore = events.slice(0, firstSearchAfterRead).filter((event) => event.tool === "read_section");
  if (readsBefore.length === 0) {
    return false;
  }

  return readsBefore.every((event) => event.field === "code_text");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }

  let intersect = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersect += 1;
    }
  }

  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

function parseArgs(args: string[]): AnalyzeOptions {
  const defaults: AnalyzeOptions = {
    latest: false
  };

  const out = { ...defaults };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--input" && next) {
      out.input = next;
      i += 1;
      continue;
    }
    if (arg === "--process-id" && next) {
      out.processId = parseInt(next, 10);
      i += 1;
      continue;
    }
    if (arg === "--trace-id" && next) {
      out.traceId = next;
      i += 1;
      continue;
    }
    if (arg === "--latest") {
      out.latest = true;
    }
  }

  return out;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await analyzeTraceFromOptions(options);

  process.stdout.write(`Process: ${result.processId ?? "n/a"}\n`);
  process.stdout.write(`Steps: ${result.totalSteps}\n`);
  process.stdout.write(`Flags: ${result.flags.length > 0 ? result.flags.join(", ") : "none"}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[trace-analyze] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
