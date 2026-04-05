import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logInfo } from "./logger.js";
import { DocsService } from "./service.js";
import { MCP_RUNTIME_CONFIG } from "./config.js";
import { createTelemetrySinkFromEnv, toTelemetryPreview, type TelemetrySink } from "./telemetry.js";
import { clamp, paginateTextWindow } from "./util.js";
import packageJson from "../package.json" with { type: "json" };
import type { DocChunk, PageSummary, SearchMode, SearchResult, StatusReport } from "./types.js";

const SEGMENT_KINDS = ["heading", "prose", "code", "admonition", "image"] as const;
const MAX_SEARCH_OFFSET = 2000;
const MAX_WITHIN_PAGE_OFFSET = 500;
const MAX_LIST_PAGES_LIMIT = 100;
const MAX_CONTEXT_WINDOW = 3;
const DEFAULT_SEARCH_LIMIT = 3;
const DEFAULT_WITHIN_PAGE_LIMIT = 3;
const DEFAULT_READ_MAX_CHARS = 800;
const DEFAULT_LIST_PAGES_LIMIT = 10;

const SEARCH_RESULT_SCHEMA = z.object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    headings: z.array(z.string()),
    score: z.number(),
    snippet: z.string()
});

const CHUNK_REF_SCHEMA = z.object({
    id: z.string(),
    path: z.string(),
    title: z.string(),
    headings: z.array(z.string()),
    pageOrder: z.number().int()
});

const NEIGHBOR_REF_SCHEMA = CHUNK_REF_SCHEMA.extend({
    preview: z.string(),
    bodyLength: z.number().int().min(0),
    codeLength: z.number().int().min(0)
});

const WINDOW_SCHEMA = z.object({
    value: z.string(),
    offset: z.number().int().min(0),
    length: z.number().int().min(0),
    hasMore: z.boolean(),
    nextOffset: z.number().int().min(0).nullable(),
    totalChars: z.number().int().min(0)
});

const SEGMENT_WINDOW_SCHEMA = z.object({
    index: z.number().int().min(0),
    kind: z.enum(SEGMENT_KINDS),
    window: WINDOW_SCHEMA
});

const SEARCH_DOCS_OUTPUT_SCHEMA = z.object({
    query: z.string(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    count: z.number().int().min(0),
    results: z.array(SEARCH_RESULT_SCHEMA)
});

const SEARCH_WITHIN_PAGE_OUTPUT_SCHEMA = z.object({
    path: z.string(),
    query: z.string(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    count: z.number().int().min(0),
    results: z.array(SEARCH_RESULT_SCHEMA)
});

const READ_SECTION_OUTPUT_SCHEMA = CHUNK_REF_SCHEMA.partial().extend({
    segment: SEGMENT_WINDOW_SCHEMA.optional(),
    segmentCount: z.number().int().min(0).optional(),
    kinds: z.array(z.enum(SEGMENT_KINDS)).optional(),
    firstCodeIndex: z.number().int().min(0).nullable().optional(),
    resolvedSegmentIndex: z.number().int().min(0).optional(),
    neighbors: z
        .object({
            before: z.array(NEIGHBOR_REF_SCHEMA),
            after: z.array(NEIGHBOR_REF_SCHEMA)
        })
        .optional(),
    error: z.string().optional()
});

const READ_CONTEXT_OUTPUT_SCHEMA = z.object({
    id: z.string(),
    before: z.number().int().min(0),
    after: z.number().int().min(0),
    count: z.number().int().min(0),
    chunks: z.array(CHUNK_REF_SCHEMA)
});

const LIST_PAGES_OUTPUT_SCHEMA = z.object({
    prefix: z.string(),
    limit: z.number().int().min(1),
    count: z.number().int().min(0),
    pages: z.array(
        z.object({
            path: z.string(),
            title: z.string(),
            chunkCount: z.number().int().min(0)
        })
    )
});

const LIST_HEADINGS_OUTPUT_SCHEMA = z.object({
    path: z.string(),
    count: z.number().int().min(0),
    headings: z.array(
        z.object({
            headingKey: z.string(),
            firstChunkId: z.string(),
            chunkCount: z.number().int().min(0)
        })
    )
});

const STATUS_OUTPUT_SCHEMA = z
    .object({
        sourceUrl: z.string(),
        cachePath: z.string(),
        storageMode: z.string(),
        hasCache: z.boolean(),
        freshness: z.object({ state: z.enum(["fresh", "stale-soft", "stale-hard", "missing"]) }).passthrough(),
        index: z.object({ chunkCount: z.number().int().min(0), pageCount: z.number().int().min(0) }).passthrough()
    })
    .passthrough();

const REFRESH_OUTPUT_SCHEMA = z
    .object({
        refreshed: z.boolean(),
        force: z.boolean(),
        chunkCount: z.number().int().min(0),
        metadata: z.unknown(),
        status: STATUS_OUTPUT_SCHEMA
    })
    .passthrough();

const ENFORCED_SEARCH_LIMIT = MCP_RUNTIME_CONFIG.maxSearchLimit;
const ENFORCED_WITHIN_PAGE_LIMIT = MCP_RUNTIME_CONFIG.maxWithinPageLimit;
const ENFORCED_READ_MAX_CHARS = MCP_RUNTIME_CONFIG.maxReadChars;

const TOOL_DESCRIPTIONS = {
    search_docs: "Start here: global docs search. Once a relevant page is found, prefer local navigation over another global search.",
    search_within_page: "Narrow within a known page after global search. Prefer this over another global search.",
    list_headings: "Inspect sections within a known page before reading a chunk.",
    read_section:
        "Read one chunk with pagination. Prefer neighbors.before/after for the next local read before running another global search.",
    read_context: "Expand nearby refs around one chunk when immediate neighbor refs are not enough.",
    list_pages: "Discovery only when search does not identify a relevant page.",
    get_status: "Get cache and index status.",
    refresh_docs: "Refresh source docs and rebuild the index.",
} as const;

type SegmentKind = (typeof SEGMENT_KINDS)[number];

interface DocsServiceApi {
    initialize(): Promise<void>;
    searchDocs(query: string, limit?: number, mode?: SearchMode, debug?: boolean, offset?: number): Promise<SearchResult[]>;
    readSection(id: string): Promise<DocChunk | null>;
    readContext(id: string, before?: number, after?: number, mode?: "section"): Promise<DocChunk[]>;
    getNeighbors(id: string, before?: number, after?: number): Promise<{ before: DocChunk[]; after: DocChunk[] }>;
    listPages(prefix?: string, limit?: number): Promise<PageSummary[]>;
    listHeadings(path: string): Promise<Array<{ headingKey: string; firstChunkId: string; chunkCount: number }>>;
    searchWithinPage(
        path: string,
        query: string,
        limit?: number,
        mode?: SearchMode,
        debug?: boolean,
        offset?: number
    ): Promise<SearchResult[]>;
    getStatus(): Promise<StatusReport>;
    refresh(force?: boolean): Promise<{ refreshed: boolean; chunkCount: number; metadata: unknown }>;
}

interface CreateServerOptions {
    service?: DocsServiceApi;
    telemetry?: TelemetrySink | null;
}

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

    const server = createMcpServer({ service, telemetry });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

export function createMcpServer(options: CreateServerOptions = {}): McpServer {
    const service = options.service ?? new DocsService();
    const telemetry = options.telemetry ?? null;

    const server = new McpServer(
        {
            name: "marten-docs-mcp",
            version: packageJson.version
        },
        {
            instructions:
                "Marten documentation retrieval server. Start with search_docs. When a relevant page or chunk is found, prefer read_section and use neighbors.before/after for immediate local navigation. Use search_within_page or list_headings to narrow within a known page. Use read_context only to expand nearby refs when local neighbors are not enough. Prefer short intent-focused queries, including exact API names when relevant. Avoid repeated global searches once a relevant page has been found."
        }
    );

    server.registerTool(
        "search_docs",
        {
            description: TOOL_DESCRIPTIONS.search_docs,
            inputSchema: {
                query: z.string().min(1),
                limit: z.number().int().min(1).max(ENFORCED_SEARCH_LIMIT).optional(),
                offset: z.number().int().min(0).max(MAX_SEARCH_OFFSET).optional()
            },
            outputSchema: SEARCH_DOCS_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ query, limit, offset }: { query: string; limit?: number; offset?: number }) => {
            const safeOffset = clamp(offset ?? 0, 0, MAX_SEARCH_OFFSET);
            const searchQuery = query.trim();
            const selectedLimit = clamp(limit ?? DEFAULT_SEARCH_LIMIT, 1, ENFORCED_SEARCH_LIMIT);

            const results = await service.searchDocs(searchQuery, selectedLimit, "auto", false, safeOffset);
            const payload = {
                query,
                offset: safeOffset,
                limit: selectedLimit,
                count: results.length,
                results: results.map(toPublicSearchResult)
            };

            telemetry?.record({
                tool: "search_docs",
                query: searchQuery,
                queryTerms: tokenizeForTelemetry(searchQuery),
                mode: "auto",
                limit: selectedLimit,
                offset: safeOffset,
                debug: false,
                count: results.length,
                topResultPaths: results.slice(0, 5).map((row) => row.path),
                topResults: toTelemetryTopResults(results)
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    server.registerTool(
        "search_within_page",
        {
            description: TOOL_DESCRIPTIONS.search_within_page,
            inputSchema: {
                path: z.string().min(1),
                query: z.string().min(1),
                limit: z.number().int().min(1).max(ENFORCED_WITHIN_PAGE_LIMIT).optional(),
                offset: z.number().int().min(0).max(MAX_WITHIN_PAGE_OFFSET).optional()
            },
            outputSchema: SEARCH_WITHIN_PAGE_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ path, query, limit, offset }: { path: string; query: string; limit?: number; offset?: number }) => {
            const safeOffset = clamp(offset ?? 0, 0, MAX_WITHIN_PAGE_OFFSET);
            const searchQuery = query.trim();
            const selectedLimit = clamp(limit ?? DEFAULT_WITHIN_PAGE_LIMIT, 1, ENFORCED_WITHIN_PAGE_LIMIT);

            const results = await service.searchWithinPage(path, searchQuery, selectedLimit, "auto", false, safeOffset);
            const payload = {
                path,
                query,
                offset: safeOffset,
                limit: selectedLimit,
                count: results.length,
                results: results.map(toPublicSearchResult)
            };

            telemetry?.record({
                tool: "search_within_page",
                path,
                query: searchQuery,
                queryTerms: tokenizeForTelemetry(searchQuery),
                mode: "auto",
                limit: selectedLimit,
                offset: safeOffset,
                debug: false,
                count: results.length,
                topChunkIds: results.slice(0, 8).map((row) => row.id),
                topResultPaths: results.slice(0, 5).map((row) => row.path),
                topResults: toTelemetryTopResults(results)
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    server.registerTool(
        "list_headings",
        {
            description: TOOL_DESCRIPTIONS.list_headings,
            inputSchema: {
                path: z.string().min(1)
            },
            outputSchema: LIST_HEADINGS_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ path }: { path: string }) => {
            const headings = await service.listHeadings(path);
            const headingRefs = headings.map((heading) => ({
                headingKey: heading.headingKey,
                firstChunkId: heading.firstChunkId,
                chunkCount: heading.chunkCount
            }));
            const payload = {
                path,
                count: headingRefs.length,
                headings: headingRefs
            };

            telemetry?.record({
                tool: "list_headings",
                path,
                count: headingRefs.length
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    server.registerTool(
        "read_section",
        {
            description: TOOL_DESCRIPTIONS.read_section,
            inputSchema: {
                id: z.string().min(1),
                segmentIndex: z.number().int().min(0).max(200).optional(),
                offset: z.number().int().min(0).max(2_000_000).optional(),
                maxChars: z.number().int().min(200).max(ENFORCED_READ_MAX_CHARS).optional()
            },
            outputSchema: READ_SECTION_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ id, segmentIndex, offset, maxChars }: { id: string; segmentIndex?: number; offset?: number; maxChars?: number }) => {
            const selectedOffset = offset ?? 0;
            const selectedMaxChars = clamp(maxChars ?? DEFAULT_READ_MAX_CHARS, 200, ENFORCED_READ_MAX_CHARS);

            const chunk = await service.readSection(id);
            const neighbors = chunk ? await service.getNeighbors(id, 1, 1) : { before: [], after: [] };
            const selectedSegment = chunk ? selectReadSegment(chunk, segmentIndex) : null;
            const segmentWindow = selectedSegment
                ? {
                    index: selectedSegment.index,
                    kind: selectedSegment.kind,
                    window: paginateTextWindow(selectedSegment.text, selectedOffset, selectedMaxChars)
                }
                : undefined;

            const payload = chunk
                ? {
                    ...toChunkRef(chunk),
                    segment: segmentWindow,
                    segmentCount: (chunk.segments ?? []).length,
                    kinds: (chunk.segments ?? []).map((segment) => segment.kind),
                    firstCodeIndex: findFirstCodeIndex(chunk),
                    resolvedSegmentIndex: selectedSegment?.index,
                    neighbors: {
                        before: neighbors.before.map(toNeighborRef),
                        after: neighbors.after.map(toNeighborRef)
                    }
                }
                : {
                    id,
                    error: "not_found"
                };

            telemetry?.record({
                tool: "read_section",
                id,
                requestedSegmentIndex: segmentIndex ?? null,
                resolvedSegmentIndex: selectedSegment?.index ?? null,
                segmentKind: selectedSegment?.kind ?? null,
                found: chunk !== null,
                path: chunk?.path ?? null,
                offset: selectedOffset,
                maxChars: selectedMaxChars,
                returnedChars: segmentWindow?.window.length ?? 0,
                hasMore: segmentWindow?.window.hasMore ?? false,
                preview: segmentWindow ? toTelemetryPreview(segmentWindow.window.value, 180) : "",
                neighborChunkIds: chunk ? [...neighbors.before, ...neighbors.after].map((row) => row.id) : [],
                neighborChunkPaths: chunk ? [...neighbors.before, ...neighbors.after].map((row) => row.path) : []
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    server.registerTool(
        "read_context",
        {
            description: TOOL_DESCRIPTIONS.read_context,
            inputSchema: {
                id: z.string().min(1),
                before: z.number().int().min(0).max(MAX_CONTEXT_WINDOW).optional(),
                after: z.number().int().min(0).max(MAX_CONTEXT_WINDOW).optional()
            },
            outputSchema: READ_CONTEXT_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ id, before, after }: { id: string; before?: number; after?: number }) => {
            const safeBefore = clamp(before ?? 1, 0, MAX_CONTEXT_WINDOW);
            const safeAfter = clamp(after ?? 1, 0, MAX_CONTEXT_WINDOW);
            const context = await service.readContext(id, safeBefore, safeAfter, "section");
            const payload = {
                id,
                before: safeBefore,
                after: safeAfter,
                count: context.length,
                chunks: context.map(toChunkRef)
            };

            telemetry?.record({
                tool: "read_context",
                id,
                before: safeBefore,
                after: safeAfter,
                contextMode: "section",
                count: context.length,
                paths: Array.from(new Set(context.map((chunk) => chunk.path))),
                chunkIds: context.map((chunk) => chunk.id),
                chunkPaths: context.map((chunk) => chunk.path)
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    server.registerTool(
        "list_pages",
        {
            description: TOOL_DESCRIPTIONS.list_pages,
            inputSchema: {
                prefix: z.string().optional(),
                limit: z.number().int().min(1).max(MAX_LIST_PAGES_LIMIT).optional()
            },
            outputSchema: LIST_PAGES_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ prefix, limit }: { prefix?: string; limit?: number }) => {
            const selectedLimit = clamp(limit ?? DEFAULT_LIST_PAGES_LIMIT, 1, MAX_LIST_PAGES_LIMIT);
            const pages = await service.listPages(prefix ?? "", selectedLimit);
            const payload = {
                prefix: prefix ?? "",
                limit: selectedLimit,
                count: pages.length,
                pages
            };

            telemetry?.record({
                tool: "list_pages",
                prefix: prefix ?? "",
                limit: selectedLimit,
                count: pages.length
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    server.registerTool(
        "get_status",
        {
            description: TOOL_DESCRIPTIONS.get_status,
            inputSchema: {},
            outputSchema: STATUS_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async () => {
            const status = await service.getStatus();

            telemetry?.record({
                tool: "get_status",
                freshnessState: status.freshness.state,
                chunkCount: status.index.chunkCount,
                pageCount: status.index.pageCount
            });

            return {
                content: [{ type: "text", text: JSON.stringify(status) }],
                structuredContent: asStructuredContent(status)
            };
        }
    );

    server.registerTool(
        "refresh_docs",
        {
            description: TOOL_DESCRIPTIONS.refresh_docs,
            inputSchema: {
                force: z.boolean().optional()
            },
            outputSchema: REFRESH_OUTPUT_SCHEMA,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true
            }
        },
        async ({ force }: { force?: boolean }) => {
            const result = await service.refresh(force ?? false);
            const status = await service.getStatus();
            const payload = {
                refreshed: result.refreshed,
                force: force ?? false,
                chunkCount: result.chunkCount,
                metadata: result.metadata,
                status
            };

            telemetry?.record({
                tool: "refresh_docs",
                force: force ?? false,
                refreshed: result.refreshed,
                chunkCount: result.chunkCount,
                freshnessState: status.freshness.state
            });

            return {
                content: [{ type: "text", text: JSON.stringify(payload) }],
                structuredContent: asStructuredContent(payload)
            };
        }
    );

    return server;
}

function asStructuredContent(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

function selectReadSegment(chunk: DocChunk, requestedSegmentIndex?: number): { index: number; kind: SegmentKind; text: string } | null {
    const segments = (chunk.segments ?? []).map((segment, index) => ({
        index,
        kind: segment.kind as SegmentKind,
        text: segment.text
    }));
    if (segments.length === 0) {
        const fallback = chunk.raw_text.trim().length > 0 ? chunk.raw_text : chunk.code_text;
        return {
            index: 0,
            kind: chunk.body_text.trim().length > 0 ? "prose" : "code",
            text: fallback
        };
    }

    if (typeof requestedSegmentIndex === "number") {
        const clamped = clamp(requestedSegmentIndex, 0, segments.length - 1);
        return segments[clamped] ?? null;
    }

    const firstProseLike = segments.find((segment) => ["prose", "admonition", "image"].includes(segment.kind) && segment.text.trim().length > 0);
    if (firstProseLike) {
        return firstProseLike;
    }

    const firstCode = segments.find((segment) => segment.kind === "code" && segment.text.trim().length > 0);
    if (firstCode) {
        return firstCode;
    }

    const firstNonHeading = segments.find((segment) => segment.kind !== "heading" && segment.text.trim().length > 0);
    if (firstNonHeading) {
        return firstNonHeading;
    }

    return segments[0] ?? null;
}

function findFirstCodeIndex(chunk: DocChunk): number | null {
    const idx = (chunk.segments ?? []).findIndex((segment) => segment.kind === "code" && segment.text.trim().length > 0);
    return idx >= 0 ? idx : null;
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

function toNeighborRef(chunk: DocChunk): {
    id: string;
    path: string;
    title: string;
    headings: string[];
    pageOrder: number;
    preview: string;
    bodyLength: number;
    codeLength: number;
} {
    const previewSource =
        chunk.body_text.trim().length > 0
            ? chunk.body_text
            : chunk.raw_text.trim().length > 0
              ? chunk.raw_text
              : chunk.code_text;
    return {
        ...toChunkRef(chunk),
        preview: toTelemetryPreview(previewSource, 120),
        bodyLength: chunk.body_text.length,
        codeLength: chunk.code_text.length
    };
}

function toPublicSearchResult(result: SearchResult): {
    id: string;
    path: string;
    title: string;
    headings: string[];
    score: number;
    snippet: string;
} {
    return {
        id: result.id,
        path: result.path,
        title: result.title,
        headings: result.headings,
        score: result.score,
        snippet: result.snippet
    };
}

function toTelemetryTopResults(results: SearchResult[]): Array<{ id: string; path: string; title: string; score: number }> {
    return results.slice(0, 5).map((row) => ({
        id: row.id,
        path: row.path,
        title: row.title,
        score: row.score
    }));
}

function tokenizeForTelemetry(query: string): string[] {
    const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_<>.]+/g)
        .filter((term) => term.length > 1);
    return Array.from(new Set(terms)).slice(0, 12);
}
