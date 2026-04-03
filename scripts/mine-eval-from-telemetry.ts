import fs from "node:fs/promises";
import path from "node:path";

interface CliOptions {
  input: string;
  output: string;
  minSearches: number;
  minSelections: number;
  windowMs: number;
  minShare: number;
}

interface TelemetryEnvelope {
  schema: string;
  version: number;
  event: TelemetryEvent;
}

type TelemetryEvent =
  | {
      tool: "search_docs";
      processId: number;
      seq: number;
      ts: string;
      query: string;
      topResults: Array<{ id: string; path: string; score: number }>;
    }
  | {
      tool: "read_section";
      processId: number;
      seq: number;
      ts: string;
      path: string | null;
    }
  | {
      tool: "read_context";
      processId: number;
      seq: number;
      ts: string;
      paths: string[];
    }
  | {
      tool: "read_page";
      processId: number;
      seq: number;
      ts: string;
      path: string;
    };

interface SearchEvent {
  processId: number;
  tsMs: number;
  seq: number;
  query: string;
}

interface QueryStats {
  searches: number;
  top1PathCounts: Map<string, number>;
  selectedPathCounts: Map<string, number>;
}

interface MinedCandidate {
  query: string;
  searches: number;
  selections: number;
  top1Paths: Array<{ path: string; count: number; share: number }>;
  selectedPaths: Array<{ path: string; count: number; share: number }>;
  suggestedExpected: {
    pathIncludes?: string;
    pathAnyOf?: string[];
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const lines = (await fs.readFile(options.input, "utf8")).split(/\r?\n/);
  const events = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseEnvelope)
    .filter((event): event is TelemetryEnvelope => event !== null)
    .sort((a, b) => {
      const tDiff = tsMs(a.event.ts) - tsMs(b.event.ts);
      if (tDiff !== 0) {
        return tDiff;
      }
      return a.event.seq - b.event.seq;
    });

  const recentSearches = new Map<number, SearchEvent[]>();
  const statsByQuery = new Map<string, QueryStats>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.tool === "search_docs") {
      const stats = getOrCreateStats(statsByQuery, event.query);
      stats.searches += 1;
      const top1 = event.topResults[0]?.path;
      if (top1) {
        stats.top1PathCounts.set(top1, (stats.top1PathCounts.get(top1) ?? 0) + 1);
      }

      const list = recentSearches.get(event.processId) ?? [];
      list.push({
        processId: event.processId,
        tsMs: tsMs(event.ts),
        seq: event.seq,
        query: event.query
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

    const priorSearch = findNearestSearch(recentSearches.get(event.processId) ?? [], tsMs(event.ts), event.seq, options.windowMs);
    if (!priorSearch) {
      continue;
    }

    const stats = getOrCreateStats(statsByQuery, priorSearch.query);
    for (const selectedPath of selectedPaths) {
      stats.selectedPathCounts.set(selectedPath, (stats.selectedPathCounts.get(selectedPath) ?? 0) + 1);
    }
  }

  const candidates: MinedCandidate[] = [];
  for (const [query, stats] of statsByQuery.entries()) {
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
    candidates.push({
      query,
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

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify({ generatedAt: new Date().toISOString(), options, candidates }, null, 2)}\n`, "utf8");

  process.stdout.write(`Telemetry lines parsed: ${events.length}\n`);
  process.stdout.write(`Mined candidates: ${candidates.length}\n`);
  process.stdout.write(`Output: ${options.output}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const defaults: CliOptions = {
    input: process.env.MARTEN_MCP_TELEMETRY_PATH
      ? path.resolve(process.env.MARTEN_MCP_TELEMETRY_PATH)
      : path.join(process.cwd(), "eval", "telemetry", "mcp-telemetry.jsonl"),
    output: path.join(process.cwd(), "eval", "mined-candidates.json"),
    minSearches: 3,
    minSelections: 2,
    windowMs: 120000,
    minShare: 0.25
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
  }

  return out;
}

function parseEnvelope(line: string): TelemetryEnvelope | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const envelope = parsed as Partial<TelemetryEnvelope>;
    if (envelope.schema !== "marten-mcp-telemetry" || !envelope.event || typeof envelope.event !== "object") {
      return null;
    }

    return envelope as TelemetryEnvelope;
  } catch {
    return null;
  }
}

function selectedPathsFromReadEvent(event: TelemetryEvent): string[] {
  if (event.tool === "read_section") {
    return event.path ? [event.path] : [];
  }
  if (event.tool === "read_context") {
    return event.paths ?? [];
  }
  if (event.tool === "read_page") {
    return event.path ? [event.path] : [];
  }
  return [];
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

function getOrCreateStats(map: Map<string, QueryStats>, query: string): QueryStats {
  const existing = map.get(query);
  if (existing) {
    return existing;
  }

  const created: QueryStats = {
    searches: 0,
    top1PathCounts: new Map(),
    selectedPathCounts: new Map()
  };
  map.set(query, created);
  return created;
}

function mapCounts(counts: Map<string, number>): Array<{ path: string; count: number }> {
  return Array.from(counts.entries())
    .map(([pathValue, count]) => ({ path: pathValue, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

function withShare(entries: Array<{ path: string; count: number }>): Array<{ path: string; count: number; share: number }> {
  const total = entries.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) {
    return [];
  }

  return entries.map((item) => ({
    ...item,
    share: round(item.count / total)
  }));
}

function buildSuggestedExpected(
  selectedEntries: Array<{ path: string; count: number }>,
  selectedTotal: number,
  minShare: number
): { pathIncludes?: string; pathAnyOf?: string[] } {
  if (selectedEntries.length === 0 || selectedTotal === 0) {
    return {};
  }

  const candidates = selectedEntries.filter((item) => item.count / selectedTotal >= minShare).map((item) => item.path);
  if (candidates.length <= 1) {
    return { pathIncludes: selectedEntries[0]?.path };
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

function tsMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[mine-eval] failed: ${message}\n`);
  process.exitCode = 1;
});
