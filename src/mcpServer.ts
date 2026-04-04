import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logInfo } from "./logger.js";
import { DocsService } from "./service.js";
import { createTelemetrySinkFromEnv } from "./telemetry.js";
import { clamp, paginateTextWindow } from "./util.js";
import packageJson from "../package.json" with { type: "json" };
import type { ContextMode, DocChunk, PageSummary, SearchMode, SearchResult, StatusReport } from "./types.js";

const SEARCH_MODES = ["auto", "lexical", "trigram", "exact"] as const;
const CONTEXT_MODES = ["section"] as const;
const OUTPUT_FORMATS = ["json", "markdown"] as const;
const SECTION_FIELDS = ["raw_text", "body_text", "code_text"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type SectionField = (typeof SECTION_FIELDS)[number];

export async function startMcpServer(): Promise<void> {
  const service = new DocsService();
  void service.initialize().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logInfo("Deferred initialize failed; service will retry on demand", { error: message });
  });
  const telemetry = createTelemetrySinkFromEnv();
  if (telemetry) {
    logInfo("Telemetry enabled", { filePath: telemetry.getFilePath() });
  }

  const server = new McpServer(
    {
      name: "marten-docs-mcp",
      version: packageJson.version
    },
    {
      instructions:
        "Local MartenDB docs retrieval server. Use search_docs first, then read_section or read_context for focused context."
    }
  );

  server.tool(
    "search_docs",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(25).optional(),
      offset: z.number().int().min(0).max(2000).optional(),
      mode: z.enum(SEARCH_MODES).optional(),
      debug: z.boolean().optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({
      query,
      limit,
      offset,
      mode,
      debug,
      format
    }: {
      query: string;
      limit?: number;
      offset?: number;
      mode?: SearchMode;
      debug?: boolean;
      format?: OutputFormat;
    }) => {
      const debugEnabled = debug ?? false;
      const outputFormat = format ?? "json";
      const safeOffset = offset ?? 0;
      const results = await service.searchDocs(query, limit ?? 8, (mode ?? "auto") as SearchMode, debugEnabled, safeOffset);
      const payload = {
        query,
        mode: mode ?? "auto",
        debug: debugEnabled,
        offset: safeOffset,
        count: results.length,
        results
      };
      telemetry?.record({
        tool: "search_docs",
        queryTerms: tokenizeForTelemetry(query),
        mode: mode ?? "auto",
        limit: limit ?? 8,
        offset: safeOffset,
        debug: debugEnabled,
        count: results.length,
        topResultPaths: results.slice(0, 5).map((row) => row.path)
      });
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderSearchMarkdown(payload))
          }
        ]
      };
    }
  );

  server.tool(
    "read_section",
    {
      id: z.string().min(1),
      field: z.enum(SECTION_FIELDS).optional(),
      offset: z.number().int().min(0).max(2_000_000).optional(),
      maxChars: z.number().int().min(200).max(8_000).optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({
      id,
      field,
      offset,
      maxChars,
      format
    }: {
      id: string;
      field?: SectionField;
      offset?: number;
      maxChars?: number;
      format?: OutputFormat;
    }) => {
      const outputFormat = format ?? "json";
      const selectedField = field ?? "raw_text";
      const selectedOffset = offset ?? 0;
      const selectedMaxChars = maxChars ?? 1500;
      const chunk = await service.readSection(id);
      const payload =
        (chunk
          ? {
              ...toChunkRef(chunk),
              field: selectedField,
              window: paginateTextWindow(chunk[selectedField], selectedOffset, selectedMaxChars)
            }
          : null) ?? {
           error: "not_found",
           id
         };
      telemetry?.record({
        tool: "read_section",
        id,
        field: selectedField,
        found: chunk !== null,
        path: chunk?.path ?? null
      });
      return {
        content: [
          {
            type: "text",
            text: renderOutput(
              outputFormat,
              payload,
              chunk
                ? renderChunkMarkdown(chunk, {
                    field: selectedField,
                    offset: selectedOffset,
                    maxChars: selectedMaxChars
                  })
                : `Not found: \`${id}\``
            )
          }
        ]
      };
    }
  );

  server.tool(
    "read_context",
    {
      id: z.string().min(1),
      before: z.number().int().min(0).max(3).optional(),
      after: z.number().int().min(0).max(3).optional(),
      contextMode: z.enum(CONTEXT_MODES).optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({
      id,
      before,
      after,
      contextMode,
      format
    }: {
      id: string;
      before?: number;
      after?: number;
      contextMode?: ContextMode;
      format?: OutputFormat;
    }) => {
      const mode = contextMode ?? "section";
      const outputFormat = format ?? "json";
      const safeBefore = clamp(before ?? 1, 0, 3);
      const safeAfter = clamp(after ?? 1, 0, 3);
      const context = await service.readContext(id, safeBefore, safeAfter, mode);
      const payload = {
        id,
        before: safeBefore,
        after: safeAfter,
        contextMode: mode,
        count: context.length,
        chunks: context.map(toChunkRef)
      };
      telemetry?.record({
        tool: "read_context",
        id,
        before: safeBefore,
        after: safeAfter,
        contextMode: mode,
        count: context.length,
        paths: Array.from(new Set(context.map((chunk) => chunk.path)))
      });
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderContextMarkdown(payload))
          }
        ]
      };
    }
  );

  server.tool(
    "list_pages",
    {
      prefix: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({ prefix, limit, format }: { prefix?: string; limit?: number; format?: OutputFormat }) => {
      const outputFormat = format ?? "json";
      const pages = await service.listPages(prefix ?? "", limit ?? 25);
      const payload = {
        prefix: prefix ?? "",
        limit: limit ?? 25,
        count: pages.length,
        pages
      };
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderPagesMarkdown(payload.pages))
          }
        ]
      };
    }
  );

  server.tool(
    "list_headings",
    {
      path: z.string().min(1),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({ path, format }: { path: string; format?: OutputFormat }) => {
      const outputFormat = format ?? "json";
      const headings = await service.listHeadings(path);
      const payload = {
        path,
        count: headings.length,
        headings
      };
      telemetry?.record({
        tool: "list_headings",
        path,
        count: headings.length
      });
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderHeadingsMarkdown(path, headings))
          }
        ]
      };
    }
  );

  server.tool(
    "search_within_page",
    {
      path: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      offset: z.number().int().min(0).max(500).optional(),
      mode: z.enum(SEARCH_MODES).optional(),
      debug: z.boolean().optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({
      path,
      query,
      limit,
      offset,
      mode,
      debug,
      format
    }: {
      path: string;
      query: string;
      limit?: number;
      offset?: number;
      mode?: SearchMode;
      debug?: boolean;
      format?: OutputFormat;
    }) => {
      const outputFormat = format ?? "json";
      const debugEnabled = debug ?? false;
      const safeOffset = offset ?? 0;
      const results = await service.searchWithinPage(path, query, limit ?? 6, mode ?? "auto", debugEnabled, safeOffset);
      const payload = {
        path,
        query,
        mode: mode ?? "auto",
        debug: debugEnabled,
        offset: safeOffset,
        count: results.length,
        results
      };
      telemetry?.record({
        tool: "search_within_page",
        path,
        queryTerms: tokenizeForTelemetry(query),
        mode: mode ?? "auto",
        limit: limit ?? 6,
        offset: safeOffset,
        debug: debugEnabled,
        count: results.length,
        topChunkIds: results.slice(0, 8).map((row) => row.id)
      });
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderSearchMarkdown(payload))
          }
        ]
      };
    }
  );

  server.tool("get_status", { format: z.enum(OUTPUT_FORMATS).optional() }, async ({ format }: { format?: OutputFormat }) => {
    const outputFormat = format ?? "json";
    const status = await service.getStatus();
    return {
      content: [
        {
          type: "text",
          text: renderOutput(outputFormat, status, renderStatusMarkdown(status))
        }
      ]
    };
  });

  server.tool(
    "refresh_docs",
    {
      force: z.boolean().optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({ force, format }: { force?: boolean; format?: OutputFormat }) => {
      const outputFormat = format ?? "json";
      const result = await service.refresh(force ?? false);
      const status = await service.getStatus();
      const payload = {
        refreshed: result.refreshed,
        force: force ?? false,
        chunkCount: result.chunkCount,
        metadata: result.metadata,
        status
      };
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderRefreshMarkdown(payload))
          }
        ]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function renderOutput(format: OutputFormat, payload: unknown, markdown: string): string {
  if (format === "markdown") {
    return markdown;
  }

  return JSON.stringify(payload, null, 2);
}

function renderSearchMarkdown(input: {
  query: string;
  mode: SearchMode;
  offset: number;
  count: number;
  results: SearchResult[];
}): string {
  const lines = [`Search: \`${input.query}\``, `Mode: \`${input.mode}\`, Offset: ${input.offset}, Count: ${input.count}`];
  for (const [index, row] of input.results.entries()) {
    lines.push(
      `${index + 1}. \`${row.path}\` (score ${row.score})`,
      `   id: \`${row.id}\``,
      `   headings: ${row.headings.join(" > ") || "(none)"}`,
      `   snippet: ${row.snippet}`
    );
  }
  return lines.join("\n");
}

function renderChunkMarkdown(
  chunk: DocChunk,
  options: {
    field: SectionField;
    offset: number;
    maxChars: number;
  }
): string {
  const window = paginateTextWindow(chunk[options.field], options.offset, options.maxChars);
  return [
    `Chunk: \`${chunk.id}\``,
    `Path: \`${chunk.path}\``,
    `Title: ${chunk.title}`,
    `Headings: ${chunk.headings.join(" > ") || "(none)"}`,
    `Field: \`${options.field}\``,
    `Window: offset=${window.offset}, length=${window.length}, hasMore=${window.hasMore}`,
    "",
    window.value
  ].join("\n");
}

function renderContextMarkdown(input: {
  id: string;
  before: number;
  after: number;
  contextMode: ContextMode;
  count: number;
  chunks: Array<Pick<DocChunk, "id" | "path" | "headings">>;
}): string {
  const lines = [
    `Context for \`${input.id}\``,
    `Mode: \`${input.contextMode}\`, before=${input.before}, after=${input.after}, count=${input.count}`
  ];
  for (const chunk of input.chunks) {
    lines.push(`- \`${chunk.id}\` \`${chunk.path}\` ${chunk.headings.join(" > ")}`);
  }
  return lines.join("\n");
}

function renderPagesMarkdown(pages: PageSummary[]): string {
  const lines = [`Pages: ${pages.length}`];
  for (const page of pages) {
    lines.push(`- \`${page.path}\` (${page.chunkCount} chunks) - ${page.title}`);
  }
  return lines.join("\n");
}

function renderHeadingsMarkdown(
  path: string,
  headings: Array<{ headingKey: string; firstChunkId: string; chunkCount: number }>
): string {
  const lines = [`Page: \`${path}\``, `Headings: ${headings.length}`];
  for (const heading of headings) {
    lines.push(`- \`${heading.firstChunkId}\` (${heading.chunkCount} chunks) ${heading.headingKey || "(none)"}`);
  }
  return lines.join("\n");
}

function renderStatusMarkdown(status: StatusReport): string {
  const backoff = status.freshness.validationBackoff;
  const latestFailure = status.freshness.validationFailureHistory[0];
  const bg = status.freshness.backgroundRefresh;
  return [
    `Source: ${status.sourceUrl}`,
    `Storage: ${status.storageMode}, cache=\`${status.cachePath}\` (${status.hasCache ? "present" : "missing"})`,
    `Freshness: ${status.freshness.state}, age=${status.freshness.ageSinceValidationHours ?? "n/a"}h`,
    `Backoff: active=${backoff.active}, retryInSeconds=${backoff.retryInSeconds ?? "n/a"}, failures=${backoff.consecutiveFailures}`,
    `Validation history: count=${status.freshness.validationFailureHistory.length}, latest=${latestFailure ? `${latestFailure.at} ${latestFailure.message}` : "none"}`,
    `Background refresh: running=${bg.running}, lastResult=${bg.lastResult ?? "none"}`,
    `Index: ready=${status.index.ready}, chunks=${status.index.chunkCount}, pages=${status.index.pageCount}`,
    `Parser: mode=${status.index.parseDiagnostics?.mode ?? "n/a"}, malformed=${status.index.parseDiagnostics?.malformedMarkerCount ?? 0}`
  ].join("\n");
}

function renderRefreshMarkdown(input: {
  refreshed: boolean;
  force: boolean;
  chunkCount: number;
  status: StatusReport;
}): string {
  return [
    `Refresh complete: ${input.refreshed ? "changed" : "unchanged"}`,
    `Force: ${input.force}`,
    `Chunk count: ${input.chunkCount}`,
    `Freshness state: ${input.status.freshness.state}`
  ].join("\n");
}

function toChunkRef(chunk: DocChunk): Pick<DocChunk, "id" | "path" | "title" | "headings" | "pageOrder"> {
  return {
    id: chunk.id,
    path: chunk.path,
    title: chunk.title,
    headings: chunk.headings,
    pageOrder: chunk.pageOrder
  };
}

function tokenizeForTelemetry(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_<>.]+/g)
    .filter((term) => term.length > 1);
  return Array.from(new Set(terms)).slice(0, 12);
}
