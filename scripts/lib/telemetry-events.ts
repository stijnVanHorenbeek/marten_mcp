import fs from "node:fs/promises";

export interface TelemetryTopResultSummary {
  id: string;
  path: string;
  title: string;
  score: number;
}

interface TelemetryEventBase {
  tool: string;
  processId: number;
  seq: number;
  ts: string;
  sessionId?: string;
}

export type TelemetryEvent =
  | (TelemetryEventBase & {
      tool: "search_docs";
      queryTerms: string[];
      query?: string;
      mode?: string;
      limit?: number;
      offset?: number;
      debug?: boolean;
      count?: number;
      topResultPaths?: string[];
      topResults?: TelemetryTopResultSummary[];
      queryClass?: string;
      lexicalTerms?: string[];
      identifierTerms?: string[];
      suppressedTerms?: string[];
    })
  | (TelemetryEventBase & {
      tool: "search_within_page";
      path: string;
      queryTerms: string[];
      query?: string;
      mode?: string;
      limit?: number;
      offset?: number;
      debug?: boolean;
      count?: number;
      topChunkIds?: string[];
      topResultPaths?: string[];
      topResults?: TelemetryTopResultSummary[];
      queryClass?: string;
      lexicalTerms?: string[];
      identifierTerms?: string[];
      suppressedTerms?: string[];
    })
  | (TelemetryEventBase & {
      tool: "read_section";
      id: string;
      requestedSegmentIndex?: number | null;
      resolvedSegmentIndex?: number | null;
      segmentKind?: "heading" | "prose" | "code" | "admonition" | "image" | null;
      found?: boolean;
      path?: string | null;
      offset?: number;
      maxChars?: number;
      returnedChars?: number;
      hasMore?: boolean;
      preview?: string;
      neighborChunkIds?: string[];
      neighborChunkPaths?: string[];
    })
  | (TelemetryEventBase & {
      tool: "read_context";
      id: string;
      before?: number;
      after?: number;
      contextMode?: string;
      count?: number;
      paths?: string[];
      chunkIds?: string[];
      chunkPaths?: string[];
      contextCharsRead?: number;
    })
  | (TelemetryEventBase & {
      tool: "list_headings";
      path: string;
      count?: number;
    })
  | (TelemetryEventBase & {
      tool: "list_pages";
      prefix?: string;
      limit?: number;
      count?: number;
    })
  | (TelemetryEventBase & {
      tool: "get_status";
      freshnessState?: string;
      chunkCount?: number;
      pageCount?: number;
    })
  | (TelemetryEventBase & {
      tool: "refresh_docs";
      force?: boolean;
      refreshed?: boolean;
      chunkCount?: number;
      freshnessState?: string;
    });

export interface TelemetryEnvelope {
  schema: "marten-mcp-telemetry";
  version: number;
  event: TelemetryEvent;
}

export async function readTelemetryFile(inputPath: string): Promise<TelemetryEnvelope[]> {
  const content = await fs.readFile(inputPath, "utf8");
  return parseTelemetryLines(content.split(/\r?\n/));
}

export function parseTelemetryLines(lines: string[]): TelemetryEnvelope[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseTelemetryLine)
    .filter((value): value is TelemetryEnvelope => value !== null)
    .sort((a, b) => {
      const byTs = tsMs(a.event.ts) - tsMs(b.event.ts);
      if (byTs !== 0) {
        return byTs;
      }
      return a.event.seq - b.event.seq;
    });
}

export function parseTelemetryLine(line: string): TelemetryEnvelope | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const envelope = parsed as Partial<TelemetryEnvelope>;
    if (envelope.schema !== "marten-mcp-telemetry") {
      return null;
    }

    if (!envelope.event || typeof envelope.event !== "object") {
      return null;
    }

    const event = envelope.event as Partial<TelemetryEvent>;
    if (typeof event.tool !== "string") {
      return null;
    }
    if (typeof event.processId !== "number" || !Number.isFinite(event.processId)) {
      return null;
    }
    if (typeof event.seq !== "number" || !Number.isFinite(event.seq)) {
      return null;
    }
    if (typeof event.ts !== "string") {
      return null;
    }

    return envelope as TelemetryEnvelope;
  } catch {
    return null;
  }
}

export function selectTrace(
  envelopes: TelemetryEnvelope[],
  options: { processId?: number; traceId?: string; latest?: boolean }
): TelemetryEnvelope[] {
  let filtered = envelopes;
  if (typeof options.processId === "number") {
    filtered = filtered.filter((row) => row.event.processId === options.processId);
  }
  if (options.traceId && options.traceId.trim().length > 0) {
    filtered = filtered.filter((row) => row.event.sessionId === options.traceId);
  }

  if (filtered.length === 0) {
    return [];
  }

  if (options.latest) {
    const latestProcessId = latestProcess(filtered);
    return filtered.filter((row) => row.event.processId === latestProcessId);
  }

  return filtered;
}

function latestProcess(envelopes: TelemetryEnvelope[]): number {
  let latestPid = envelopes[0]?.event.processId ?? 0;
  let latestTs = 0;
  for (const row of envelopes) {
    const ts = tsMs(row.event.ts);
    if (ts >= latestTs) {
      latestTs = ts;
      latestPid = row.event.processId;
    }
  }
  return latestPid;
}

export function tsMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
