import fs from "node:fs/promises";
import path from "node:path";
import { resolveCachePaths } from "./config.js";
import { logWarn } from "./logger.js";

const TELEMETRY_VERSION = 1;

interface TelemetryBase {
  tool: string;
  processId: number;
  seq: number;
  ts: string;
}

type TelemetryEventInput =
  | {
      tool: "search_docs";
      queryTerms: string[];
      mode: string;
      limit: number;
      offset: number;
      debug: boolean;
      count: number;
      topResultPaths: string[];
    }
  | {
      tool: "read_section";
      id: string;
      field: "raw_text" | "body_text" | "code_text";
      found: boolean;
      path: string | null;
    }
  | {
      tool: "read_context";
      id: string;
      before: number;
      after: number;
      contextMode: string;
      count: number;
      paths: string[];
    }
  | {
      tool: "list_headings";
      path: string;
      count: number;
    }
  | {
      tool: "search_within_page";
      path: string;
      queryTerms: string[];
      mode: string;
      limit: number;
      offset: number;
      debug: boolean;
      count: number;
      topChunkIds: string[];
    };

interface SearchTelemetryEvent extends TelemetryBase {
  tool: "search_docs";
  queryTerms: string[];
  mode: string;
  limit: number;
  offset: number;
  debug: boolean;
  count: number;
  topResultPaths: string[];
}

interface ReadSectionTelemetryEvent extends TelemetryBase {
  tool: "read_section";
  id: string;
  field: "raw_text" | "body_text" | "code_text";
  found: boolean;
  path: string | null;
}

interface ReadContextTelemetryEvent extends TelemetryBase {
  tool: "read_context";
  id: string;
  before: number;
  after: number;
  contextMode: string;
  count: number;
  paths: string[];
}

interface ListHeadingsTelemetryEvent extends TelemetryBase {
  tool: "list_headings";
  path: string;
  count: number;
}

interface SearchWithinPageTelemetryEvent extends TelemetryBase {
  tool: "search_within_page";
  path: string;
  queryTerms: string[];
  mode: string;
  limit: number;
  offset: number;
  debug: boolean;
  count: number;
  topChunkIds: string[];
}

type TelemetryEvent =
  | SearchTelemetryEvent
  | ReadSectionTelemetryEvent
  | ReadContextTelemetryEvent
  | ListHeadingsTelemetryEvent
  | SearchWithinPageTelemetryEvent;

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
