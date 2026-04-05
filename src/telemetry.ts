import fs from "node:fs/promises";
import path from "node:path";
import { resolveCachePaths } from "./config.js";
import { logWarn } from "./logger.js";

const TELEMETRY_VERSION = 1;

interface TelemetryBase {
  tool: string;
  sessionId?: string;
  processId: number;
  seq: number;
  ts: string;
}

interface TelemetryInputBase {
  sessionId?: string;
}

interface TelemetryTopResultSummary {
  id: string;
  path: string;
  title: string;
  score: number;
}

type TelemetryEventInput =
  TelemetryInputBase &
  (
  | {
      tool: "search_docs";
      query?: string;
      queryTerms: string[];
      mode: string;
      limit: number;
      offset: number;
      debug: boolean;
      count: number;
      topResultPaths: string[];
      topResults?: TelemetryTopResultSummary[];
      queryClass?: string;
      lexicalTerms?: string[];
      identifierTerms?: string[];
      suppressedTerms?: string[];
    }
  | {
      tool: "read_section";
      id: string;
      requestedSegmentIndex: number | null;
      resolvedSegmentIndex: number | null;
      segmentKind: "heading" | "prose" | "code" | "admonition" | "image" | null;
      found: boolean;
      path: string | null;
      offset?: number;
      maxChars?: number;
      returnedChars?: number;
      hasMore?: boolean;
      preview?: string;
      neighborChunkIds?: string[];
      neighborChunkPaths?: string[];
    }
  | {
      tool: "read_context";
      id: string;
      before: number;
      after: number;
      contextMode: string;
      count: number;
      paths: string[];
      chunkIds?: string[];
      chunkPaths?: string[];
      contextCharsRead?: number;
    }
  | {
      tool: "list_headings";
      path: string;
      count: number;
    }
  | {
      tool: "search_within_page";
      path: string;
      query?: string;
      queryTerms: string[];
      mode: string;
      limit: number;
      offset: number;
      debug: boolean;
      count: number;
      topChunkIds: string[];
      topResultPaths?: string[];
      topResults?: TelemetryTopResultSummary[];
      queryClass?: string;
      lexicalTerms?: string[];
      identifierTerms?: string[];
      suppressedTerms?: string[];
    }
  | {
      tool: "list_pages";
      prefix: string;
      limit: number;
      count: number;
    }
  | {
      tool: "get_status";
      freshnessState: string;
      chunkCount: number;
      pageCount: number;
    }
  | {
      tool: "refresh_docs";
      force: boolean;
      refreshed: boolean;
      chunkCount: number;
      freshnessState: string;
    });

interface SearchTelemetryEvent extends TelemetryBase {
  tool: "search_docs";
  query?: string;
  queryTerms: string[];
  mode: string;
  limit: number;
  offset: number;
  debug: boolean;
  count: number;
  topResultPaths: string[];
  topResults?: TelemetryTopResultSummary[];
  queryClass?: string;
  lexicalTerms?: string[];
  identifierTerms?: string[];
  suppressedTerms?: string[];
}

interface ReadSectionTelemetryEvent extends TelemetryBase {
  tool: "read_section";
  id: string;
  requestedSegmentIndex: number | null;
  resolvedSegmentIndex: number | null;
  segmentKind: "heading" | "prose" | "code" | "admonition" | "image" | null;
  found: boolean;
  path: string | null;
  offset?: number;
  maxChars?: number;
  returnedChars?: number;
  hasMore?: boolean;
  preview?: string;
  neighborChunkIds?: string[];
  neighborChunkPaths?: string[];
}

interface ReadContextTelemetryEvent extends TelemetryBase {
  tool: "read_context";
  id: string;
  before: number;
  after: number;
  contextMode: string;
  count: number;
  paths: string[];
  chunkIds?: string[];
  chunkPaths?: string[];
  contextCharsRead?: number;
}

interface ListHeadingsTelemetryEvent extends TelemetryBase {
  tool: "list_headings";
  path: string;
  count: number;
}

interface SearchWithinPageTelemetryEvent extends TelemetryBase {
  tool: "search_within_page";
  path: string;
  query?: string;
  queryTerms: string[];
  mode: string;
  limit: number;
  offset: number;
  debug: boolean;
  count: number;
  topChunkIds: string[];
  topResultPaths?: string[];
  topResults?: TelemetryTopResultSummary[];
  queryClass?: string;
  lexicalTerms?: string[];
  identifierTerms?: string[];
  suppressedTerms?: string[];
}

interface ListPagesTelemetryEvent extends TelemetryBase {
  tool: "list_pages";
  prefix: string;
  limit: number;
  count: number;
}

interface GetStatusTelemetryEvent extends TelemetryBase {
  tool: "get_status";
  freshnessState: string;
  chunkCount: number;
  pageCount: number;
}

interface RefreshDocsTelemetryEvent extends TelemetryBase {
  tool: "refresh_docs";
  force: boolean;
  refreshed: boolean;
  chunkCount: number;
  freshnessState: string;
}

type TelemetryEvent =
  | SearchTelemetryEvent
  | ReadSectionTelemetryEvent
  | ReadContextTelemetryEvent
  | ListHeadingsTelemetryEvent
  | SearchWithinPageTelemetryEvent
  | ListPagesTelemetryEvent
  | GetStatusTelemetryEvent
  | RefreshDocsTelemetryEvent;

interface TelemetryRecord {
  schema: "marten-mcp-telemetry";
  version: number;
  event: TelemetryEvent;
}

export class TelemetrySink {
  private readonly targetPath: string;
  private readonly retentionDays: number;
  private readonly usesDirectoryLayout: boolean;
  private sequence = 0;
  private initialized = false;
  private pruned = false;
  private queue: Promise<void> = Promise.resolve();
  private writeFailed = false;

  public constructor(targetPath: string, retentionDays = 14) {
    this.targetPath = targetPath;
    this.usesDirectoryLayout = !targetPath.toLowerCase().endsWith(".jsonl");
    this.retentionDays = Math.max(1, retentionDays);
  }

  public record(event: TelemetryEventInput): void {
    const fullEvent: TelemetryEvent = {
      ...event,
      processId: process.pid,
      seq: this.nextSequence(),
      ts: new Date().toISOString()
    } as TelemetryEvent;

    const record: TelemetryRecord = {
      schema: "marten-mcp-telemetry",
      version: TELEMETRY_VERSION,
      event: fullEvent
    };

    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(async () => {
        if (!this.initialized) {
          await fs.mkdir(this.usesDirectoryLayout ? this.targetPath : path.dirname(this.targetPath), { recursive: true });
          this.initialized = true;
        }
        if (!this.pruned) {
          await this.pruneOldFiles().catch(() => {
            // best effort retention management
          });
          this.pruned = true;
        }
        await fs.appendFile(this.resolveOutputFilePath(fullEvent.ts), line, "utf8");
      })
      .catch((error) => {
        if (this.writeFailed) {
          return;
        }
        this.writeFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        logWarn("Telemetry write failed; disabling telemetry writes", {
          filePath: this.targetPath,
          error: message
        });
      });
  }

  public getFilePath(): string {
    return this.targetPath;
  }

  public async flush(): Promise<void> {
    await this.queue;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private resolveOutputFilePath(ts: string): string {
    if (!this.usesDirectoryLayout) {
      return this.targetPath;
    }

    const day = ts.slice(0, 10);
    return path.join(this.targetPath, `${day}.jsonl`);
  }

  private async pruneOldFiles(): Promise<void> {
    if (!this.usesDirectoryLayout) {
      return;
    }

    const entries = await fs.readdir(this.targetPath, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = this.retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) {
        continue;
      }

      const ts = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (!Number.isFinite(ts)) {
        continue;
      }

      if (now - ts > maxAgeMs) {
        await fs.rm(path.join(this.targetPath, entry.name), { force: true });
      }
    }
  }
}

export function createTelemetrySinkFromEnv(): TelemetrySink | null {
  const disabledRaw = process.env.MARTEN_MCP_TELEMETRY_DISABLED?.trim().toLowerCase();
  if (disabledRaw === "1" || disabledRaw === "true" || disabledRaw === "yes" || disabledRaw === "on") {
    return null;
  }

  const target = process.env.MARTEN_MCP_TELEMETRY_PATH?.trim();
  const retentionDays = parseRetentionDays(process.env.MARTEN_MCP_TELEMETRY_RETENTION_DAYS);
  const defaultPath = path.join(resolveCachePaths().dir, "telemetry");
  return new TelemetrySink(path.resolve(target || defaultPath), retentionDays);
}

export function toTelemetryPreview(value: string, maxChars = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

function parseRetentionDays(raw: string | undefined): number {
  if (!raw) {
    return 14;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 14;
  }

  return Math.round(parsed);
}
