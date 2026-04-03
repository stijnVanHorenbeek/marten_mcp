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
      query: string;
      mode: string;
      limit: number;
      offset: number;
      debug: boolean;
      count: number;
      topResults: Array<{
        id: string;
        path: string;
        score: number;
      }>;
    }
  | {
      tool: "read_section";
      id: string;
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
      chunkIds: string[];
      paths: string[];
    }
  | {
      tool: "read_page";
      path: string;
      maxChunks: number;
      count: number;
      chunkIds: string[];
    };

interface SearchTelemetryEvent extends TelemetryBase {
  tool: "search_docs";
  query: string;
  mode: string;
  limit: number;
  offset: number;
  debug: boolean;
  count: number;
  topResults: Array<{
    id: string;
    path: string;
    score: number;
  }>;
}

interface ReadSectionTelemetryEvent extends TelemetryBase {
  tool: "read_section";
  id: string;
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
  chunkIds: string[];
  paths: string[];
}

interface ReadPageTelemetryEvent extends TelemetryBase {
  tool: "read_page";
  path: string;
  maxChunks: number;
  count: number;
  chunkIds: string[];
}

type TelemetryEvent =
  | SearchTelemetryEvent
  | ReadSectionTelemetryEvent
  | ReadContextTelemetryEvent
  | ReadPageTelemetryEvent;

interface TelemetryRecord {
  schema: "marten-mcp-telemetry";
  version: number;
  event: TelemetryEvent;
}

export class TelemetrySink {
  private readonly filePath: string;
  private readonly dirPath: string;
  private sequence = 0;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  private writeFailed = false;

  public constructor(filePath: string) {
    this.filePath = filePath;
    this.dirPath = path.dirname(filePath);
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
          await fs.mkdir(this.dirPath, { recursive: true });
          this.initialized = true;
        }
        await fs.appendFile(this.filePath, line, "utf8");
      })
      .catch((error) => {
        if (this.writeFailed) {
          return;
        }
        this.writeFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        logWarn("Telemetry write failed; disabling telemetry writes", {
          filePath: this.filePath,
          error: message
        });
      });
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public async flush(): Promise<void> {
    await this.queue;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

export function createTelemetrySinkFromEnv(): TelemetrySink | null {
  const disabledRaw = process.env.MARTEN_MCP_TELEMETRY_DISABLED?.trim().toLowerCase();
  if (disabledRaw === "1" || disabledRaw === "true" || disabledRaw === "yes" || disabledRaw === "on") {
    return null;
  }

  const target = process.env.MARTEN_MCP_TELEMETRY_PATH?.trim();
  const defaultPath = path.join(resolveCachePaths().dir, "telemetry.jsonl");
  return new TelemetrySink(path.resolve(target || defaultPath));
}
