import { readTelemetryFile, selectTrace, type TelemetryEnvelope } from "./lib/telemetry-events.ts";
import { resolveTelemetryInputFile } from "./lib/telemetry-paths.ts";

export interface TraceShowOptions {
  input?: string;
  processId?: number;
  traceId?: string;
  latest: boolean;
}

export async function renderTraceFromOptions(options: TraceShowOptions): Promise<string> {
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
  return renderTrace(selected);
}

export function renderTrace(trace: TelemetryEnvelope[]): string {
  if (trace.length === 0) {
    return "No trace events found.";
  }

  const lines: string[] = [];
  const first = trace[0]?.event;
  lines.push(`Process: ${first?.processId ?? "n/a"}`);
  lines.push(`Events: ${trace.length}`);
  lines.push("");

  trace.forEach((row, index) => {
    const step = index + 1;
    const event = row.event;
    lines.push(`${step}. [${event.ts}] ${renderEventHeader(event)}`);

    const summary = renderEventSummary(event);
    if (summary.length > 0) {
      for (const entry of summary) {
        lines.push(`   ${entry}`);
      }
    }
  });

  return lines.join("\n");
}

function renderEventHeader(event: TelemetryEnvelope["event"]): string {
  if (event.tool === "search_docs") {
    const query = event.query ?? event.queryTerms.join(" ");
    return `search_docs(${JSON.stringify(query)})`;
  }
  if (event.tool === "search_within_page") {
    const query = event.query ?? event.queryTerms.join(" ");
    return `search_within_page(path=${JSON.stringify(event.path)}, query=${JSON.stringify(query)})`;
  }
  if (event.tool === "read_section") {
    return `read_section(id=${JSON.stringify(event.id)}, segmentIndex=${event.requestedSegmentIndex ?? "default"})`;
  }
  if (event.tool === "read_context") {
    return `read_context(id=${JSON.stringify(event.id)}, before=${event.before ?? 0}, after=${event.after ?? 0})`;
  }
  if (event.tool === "list_headings") {
    return `list_headings(path=${JSON.stringify(event.path)})`;
  }
  if (event.tool === "list_pages") {
    return `list_pages(prefix=${JSON.stringify(event.prefix ?? "")})`;
  }
  if (event.tool === "get_status") {
    return "get_status()";
  }
  if (event.tool === "refresh_docs") {
    return `refresh_docs(force=${event.force ? "true" : "false"})`;
  }
  return "unknown_tool";
}

function renderEventSummary(event: TelemetryEnvelope["event"]): string[] {
  if (event.tool === "search_docs" || event.tool === "search_within_page") {
    const rows = event.topResults ?? [];
    if (rows.length === 0) {
      return ["top hits: (none)"];
    }
    return [
      "top hits:",
      ...rows.map((row) => `- ${row.path} [${row.id}] (${row.score.toFixed(3)}) ${row.title}`)
    ];
  }

  if (event.tool === "read_section") {
    const out: string[] = [];
    out.push(
      `requestedSegmentIndex=${event.requestedSegmentIndex ?? "default"}, resolvedSegmentIndex=${
        event.resolvedSegmentIndex ?? "n/a"
      }, segmentKind=${event.segmentKind ?? "n/a"}`
    );
    out.push(
      `found=${event.found ? "true" : "false"}, path=${event.path ?? "n/a"}, returnedChars=${event.returnedChars ?? 0}, hasMore=${
        event.hasMore ? "true" : "false"
      }`
    );
    out.push(`offset=${event.offset ?? 0}, maxChars=${event.maxChars ?? 0}`);
    if ((event.neighborChunkIds?.length ?? 0) > 0) {
      out.push(`neighbors: ${event.neighborChunkIds?.join(", ")}`);
    }
    if (event.preview && event.preview.length > 0) {
      out.push(`preview: ${event.preview}`);
    }
    return out;
  }

  if (event.tool === "read_context") {
    const ids = event.chunkIds ?? [];
    const paths = event.chunkPaths ?? event.paths ?? [];
    return [
      `returned=${event.count ?? 0}, chunkIds=${ids.length > 0 ? ids.join(", ") : "(none)"}`,
      `chunkPaths=${paths.length > 0 ? paths.join(", ") : "(none)"}`
    ];
  }

  if (event.tool === "list_headings") {
    return [`count=${event.count ?? 0}`];
  }

  if (event.tool === "list_pages") {
    return [`count=${event.count ?? 0}, limit=${event.limit ?? 0}`];
  }

  if (event.tool === "get_status") {
    return [`freshness=${event.freshnessState ?? "n/a"}, chunks=${event.chunkCount ?? 0}, pages=${event.pageCount ?? 0}`];
  }

  if (event.tool === "refresh_docs") {
    return [`refreshed=${event.refreshed ? "true" : "false"}, chunks=${event.chunkCount ?? 0}`];
  }

  return [];
}

function parseArgs(args: string[]): TraceShowOptions {
  const defaults: TraceShowOptions = {
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
  const output = await renderTraceFromOptions(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${output}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[trace-show] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
