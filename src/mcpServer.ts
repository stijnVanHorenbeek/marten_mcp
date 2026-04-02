import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DocsService } from "./service.js";
import type { ContextMode, DocChunk, PageSummary, SearchMode, SearchResult, StatusReport } from "./types.js";

const SEARCH_MODES = ["auto", "lexical", "trigram", "exact"] as const;
const CONTEXT_MODES = ["section", "page"] as const;
const OUTPUT_FORMATS = ["json", "markdown"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];
const MAX_RAW_TEXT_CHARS = 1200;
const MAX_BODY_TEXT_CHARS = 700;
const MAX_CODE_TEXT_CHARS = 700;

export async function startMcpServer(): Promise<void> {
  const service = new DocsService();
  await service.initialize();

  const server = new McpServer(
    {
      name: "marten-docs-mcp",
      version: "0.1.0"
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
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({ id, format }: { id: string; format?: OutputFormat }) => {
      const outputFormat = format ?? "json";
      const chunk = await service.readSection(id);
      const payload =
        (chunk ? toBoundedChunk(chunk) : null) ?? {
          error: "not_found",
          id
        };
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, chunk ? renderChunkMarkdown(chunk) : `Not found: \`${id}\``)
          }
        ]
      };
    }
  );

  server.tool(
    "read_context",
    {
      id: z.string().min(1),
      before: z.number().int().min(0).max(10).optional(),
      after: z.number().int().min(0).max(10).optional(),
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
      const context = await service.readContext(id, before ?? 1, after ?? 1, mode);
      const payload = {
        id,
        before: before ?? 1,
        after: after ?? 1,
        contextMode: mode,
        count: context.length,
        chunks: context.map(toBoundedChunk)
      };
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
      limit: z.number().int().min(1).max(200).optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({ prefix, limit, format }: { prefix?: string; limit?: number; format?: OutputFormat }) => {
      const outputFormat = format ?? "json";
      const pages = await service.listPages(prefix ?? "", limit ?? 50);
      const payload = {
        prefix: prefix ?? "",
        limit: limit ?? 50,
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
    "read_page",
    {
      path: z.string().min(1),
      maxChunks: z.number().int().min(1).max(30).optional(),
      format: z.enum(OUTPUT_FORMATS).optional()
    },
    async ({ path, maxChunks, format }: { path: string; maxChunks?: number; format?: OutputFormat }) => {
      const outputFormat = format ?? "json";
      const chunks = await service.readPage(path, maxChunks ?? 12);
      const payload = {
        path,
        count: chunks.length,
        chunks: chunks.map(toBoundedChunk)
      };
      return {
        content: [
          {
            type: "text",
            text: renderOutput(outputFormat, payload, renderPageMarkdown(path, chunks))
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
      `   headings: ${row.headings.join(" > ") || "(none)"}`,
      `   snippet: ${row.snippet}`
    );
  }
  return lines.join("\n");
}

function renderChunkMarkdown(chunk: DocChunk): string {
  const bounded = toBoundedChunk(chunk);
  return [
    `Chunk: \`${bounded.id}\``,
    `Path: \`${bounded.path}\``,
    `Title: ${bounded.title}`,
    `Headings: ${bounded.headings.join(" > ") || "(none)"}`,
    "",
    bounded.raw_text
  ].join("\n");
}

function renderContextMarkdown(input: {
  id: string;
  before: number;
  after: number;
  contextMode: ContextMode;
  count: number;
  chunks: DocChunk[];
}): string {
  const lines = [
    `Context for \`${input.id}\``,
    `Mode: \`${input.contextMode}\`, before=${input.before}, after=${input.after}, count=${input.count}`
  ];
  for (const chunk of input.chunks) {
    const bounded = toBoundedChunk(chunk);
    lines.push(`- \`${bounded.id}\` \`${bounded.path}\` ${bounded.headings.join(" > ")}`);
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

function renderPageMarkdown(path: string, chunks: DocChunk[]): string {
  const lines = [`Page: \`${path}\``, `Chunks: ${chunks.length}`];
  for (const chunk of chunks) {
    const bounded = toBoundedChunk(chunk);
    lines.push(`- \`${bounded.id}\` ${bounded.headings.join(" > ") || "(none)"}`);
  }
  return lines.join("\n");
}

function renderStatusMarkdown(status: StatusReport): string {
  return [
    `Source: ${status.sourceUrl}`,
    `Cache: \`${status.cachePath}\` (${status.hasCache ? "present" : "missing"})`,
    `Freshness: ${status.freshness.state}, age=${status.freshness.ageSinceValidationHours ?? "n/a"}h`,
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

function toBoundedChunk(chunk: DocChunk): DocChunk & {
  truncation: {
    rawTextTruncated: boolean;
    bodyTextTruncated: boolean;
    codeTextTruncated: boolean;
  };
} {
  const raw = truncate(chunk.raw_text, MAX_RAW_TEXT_CHARS);
  const body = truncate(chunk.body_text, MAX_BODY_TEXT_CHARS);
  const code = truncate(chunk.code_text, MAX_CODE_TEXT_CHARS);

  return {
    ...chunk,
    raw_text: raw.value,
    body_text: body.value,
    code_text: code.value,
    truncation: {
      rawTextTruncated: raw.truncated,
      bodyTextTruncated: body.truncated,
      codeTextTruncated: code.truncated
    }
  };
}

function truncate(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  return {
    value: `${value.slice(0, maxChars)}...`,
    truncated: true
  };
}
