import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcpServer.js";
import { TelemetrySink } from "../src/telemetry.js";
import type { ContextMode, DocChunk, PageSummary, SearchMode, SearchResult, StatusReport } from "../src/types.js";

const FIXTURE_STATUS: StatusReport = {
  sourceUrl: "https://martendb.io/llms-full.txt",
  cachePath: "/tmp/marten-docs-mcp",
  storageMode: "json",
  hasCache: true,
  freshness: {
    state: "fresh",
    softTtlHours: 12,
    hardTtlHours: 168,
    ageSinceValidationHours: 1,
    lastValidationError: null,
    validationBackoff: {
      active: false,
      retryInSeconds: null,
      consecutiveFailures: 0
    },
    validationFailureHistory: [],
    backgroundRefresh: {
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastResult: null
    }
  },
  metadata: null,
  index: {
    ready: true,
    chunkCount: 2,
    pageCount: 1,
    parserVersion: "v2",
    indexVersion: "v1",
    parseDiagnostics: null
  }
};

describe("mcp server contract", () => {
  test("registers only the simplified tool surface", async () => {
    const harness = await createHarness();
    try {
      const tools = await harness.client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "get_status",
        "list_headings",
        "list_pages",
        "read_context",
        "read_section",
        "refresh_docs",
        "search_docs",
        "search_within_page"
      ]);

      const searchDocs = tools.tools.find((tool) => tool.name === "search_docs");
      const searchWithinPage = tools.tools.find((tool) => tool.name === "search_within_page");
      const searchDocsInput = ((searchDocs?.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
      const searchWithinInput = ((searchWithinPage?.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
      const searchDocsOutput = ((searchDocs?.outputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
      const searchWithinOutput = ((searchWithinPage?.outputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
      expect("mode" in searchDocsInput).toBe(false);
      expect("mode" in searchWithinInput).toBe(false);
      expect("mode" in searchDocsOutput).toBe(false);
      expect("mode" in searchWithinOutput).toBe(false);

      const resources = await tryListResources(harness.client);
      if (resources) {
        expect(resources.resources.length).toBe(0);
      }

      const templates = await tryListResourceTemplates(harness.client);
      if (templates) {
        expect(templates.resourceTemplates.length).toBe(0);
      }

      const prompts = await tryListPrompts(harness.client);
      if (prompts) {
        expect(prompts.prompts.length).toBe(0);
      }
    } finally {
      await harness.close();
    }
  });

  test("search_docs returns compact selection-oriented output", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.client.callTool({
        name: "search_docs",
        arguments: { query: "aggregate projections" }
      });

      expect(result.isError).toBeFalsy();
      const payload = result.structuredContent as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        "count",
        "limit",
        "offset",
        "query",
        "results"
      ]);
      const first = (payload.results as Array<Record<string, unknown>>)[0] ?? {};
      expect(Object.keys(first).sort()).toEqual(["headings", "id", "path", "score", "snippet", "title"]);

      const text = extractText(result);
      expect(text.includes("\n")).toBe(false);
      expect(text.includes("guidance")).toBe(false);
      expect(text.includes("retrievalPolicy")).toBe(false);
      expect(text.includes("budgetEnforcement")).toBe(false);
      expect(text.includes("effectiveQuery")).toBe(false);
      expect(text.includes("queryNormalized")).toBe(false);
      expect(text.includes("lexicalScore")).toBe(false);
      expect(text.includes("trigramScore")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test("mcp server passes raw query through without semantic rewriting", async () => {
    const service = new FakeDocsService();
    const harness = await createHarness(service);
    try {
      await harness.client.callTool({
        name: "search_docs",
        arguments: { query: '  IDocumentSession Query<User>() signature overload  ' }
      });

      expect(service.lastSearchQuery).toBe("IDocumentSession Query<User>() signature overload");
    } finally {
      await harness.close();
    }
  });

  test("read_context returns refs only", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.client.callTool({
        name: "read_context",
        arguments: { id: "chunk-1", before: 1, after: 1 }
      });

      expect(result.isError).toBeFalsy();
      const payload = result.structuredContent as {
        id: string;
        before: number;
        after: number;
        count: number;
        chunks: Array<Record<string, unknown>>;
      };

      expect(payload.id).toBe("chunk-1");
      expect(payload.count).toBe(2);
      expect(payload.chunks.length).toBe(2);
      expect("contextMode" in payload).toBe(false);
      expect(Object.keys(payload.chunks[0] ?? {}).sort()).toEqual(["headings", "id", "pageOrder", "path", "title"]);
      expect(extractText(result)).not.toContain("window");
      expect(extractText(result)).not.toContain("raw_text");
    } finally {
      await harness.close();
    }
  });

  test("read_section defaults to first prose-like segment and supports explicit segment index", async () => {
    const harness = await createHarness();
    try {
      const defaultRead = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-1" }
      });
      const defaultPayload = defaultRead.structuredContent as {
        resolvedSegmentIndex: number;
        segment: { kind: string };
        kinds: string[];
        firstCodeIndex: number | null;
      };
      expect(defaultPayload.segment.kind).toBe("prose");
      expect(defaultPayload.resolvedSegmentIndex).toBe(1);
      expect(defaultPayload.kinds.length).toBeGreaterThan(0);
      expect(defaultPayload.firstCodeIndex).toBe(2);

      const explicitCode = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-1", segmentIndex: 2 }
      });
      expect((explicitCode.structuredContent as { segment: { kind: string } }).segment.kind).toBe("code");
    } finally {
      await harness.close();
    }
  });

  test("read_section includes compact before/after neighbors", async () => {
    const harness = await createHarness();
    try {
      const middle = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-code" }
      });
      const middlePayload = middle.structuredContent as {
        neighbors?: { before: Array<Record<string, unknown>>; after: Array<Record<string, unknown>> };
      };
      expect(middlePayload.neighbors).toBeTruthy();
      const middleBefore = middlePayload.neighbors?.before ?? [];
      const middleAfter = middlePayload.neighbors?.after ?? [];
      expect(middleBefore.map((row) => row.id)).toEqual(["chunk-1"]);
      expect(middleAfter.map((row) => row.id)).toEqual(["chunk-raw"]);
      expect(Object.keys(middleBefore[0] ?? {}).sort()).toEqual([
        "bodyLength",
        "codeLength",
        "headings",
        "id",
        "pageOrder",
        "path",
        "preview",
        "title"
      ]);
      expect("body_text" in (middleBefore[0] ?? {})).toBe(false);
      expect("code_text" in (middleBefore[0] ?? {})).toBe(false);
      expect("raw_text" in (middleBefore[0] ?? {})).toBe(false);
      expect(new Set(middleBefore.map((row) => row.id)).size).toBe(middleBefore.length);
      expect(new Set(middleAfter.map((row) => row.id)).size).toBe(middleAfter.length);

      const first = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-1" }
      });
      const firstPayload = first.structuredContent as {
        neighbors?: { before: Array<Record<string, unknown>>; after: Array<Record<string, unknown>> };
      };
      expect(firstPayload.neighbors?.before).toEqual([]);
      expect(firstPayload.neighbors?.after.map((row) => row.id)).toEqual(["chunk-code"]);

      const last = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-raw" }
      });
      const lastPayload = last.structuredContent as {
        neighbors?: { before: Array<Record<string, unknown>>; after: Array<Record<string, unknown>> };
      };
      expect(lastPayload.neighbors?.before.map((row) => row.id)).toEqual(["chunk-code"]);
      expect(lastPayload.neighbors?.after).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("read_section telemetry records requested and resolved segment", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-telemetry-read-section-"));
    const telemetryFile = path.join(tempDir, "events.jsonl");
    const telemetry = new TelemetrySink(telemetryFile);
    const harness = await createHarness(new FakeDocsService(), telemetry);

    try {
      await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-code" }
      });
      await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-1", segmentIndex: 2 }
      });
      await telemetry.flush();

      const rows = (await fs.readFile(telemetryFile, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map(
          (line) =>
            JSON.parse(line) as {
              event: {
                tool: string;
                requestedSegmentIndex?: number | null;
                resolvedSegmentIndex?: number | null;
                segmentKind?: string | null;
              };
            }
        )
        .filter((row) => row.event.tool === "read_section");

      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0]?.event.requestedSegmentIndex).toBeNull();
      expect(rows[0]?.event.resolvedSegmentIndex).toBe(0);
      expect(rows[0]?.event.segmentKind).toBe("code");
      expect(rows[1]?.event.requestedSegmentIndex).toBe(2);
      expect(rows[1]?.event.resolvedSegmentIndex).toBe(2);
      expect(rows[1]?.event.segmentKind).toBe("code");
    } finally {
      await harness.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function createHarness(
  service: FakeDocsService = new FakeDocsService(),
  telemetry: TelemetrySink | null = null
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ service, telemetry });
  const client = new Client({ name: "marten-mcp-contract-test", version: "0.1.0" }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.allSettled([server.close(), clientTransport.close(), serverTransport.close()]);
    }
  };
}

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const payload = result as { content?: unknown; toolResult?: { content?: unknown } };
  const directContent = payload.content;
  const taskContent = payload.toolResult?.content;
  const content = Array.isArray(directContent) ? directContent : Array.isArray(taskContent) ? taskContent : null;
  if (!content) {
    return "";
  }

  const textPart = content.find(
    (item): item is { type: string; text?: string } =>
      typeof item === "object" && item !== null && "type" in item && (item as { type: unknown }).type === "text"
  );
  return textPart?.text ?? "";
}

async function tryListResources(client: Client): Promise<{ resources: Array<{ uri: string }> } | null> {
  try {
    return await client.listResources();
  } catch {
    return null;
  }
}

async function tryListResourceTemplates(
  client: Client
): Promise<{ resourceTemplates: Array<{ uriTemplate: string }> } | null> {
  try {
    return await client.listResourceTemplates();
  } catch {
    return null;
  }
}

async function tryListPrompts(client: Client): Promise<{ prompts: Array<{ name: string }> } | null> {
  try {
    return await client.listPrompts();
  } catch {
    return null;
  }
}

class FakeDocsService {
  public lastSearchQuery: string | null = null;

  public async initialize(): Promise<void> {}

  public async searchDocs(
    query: string,
    limit = 5,
    _mode: SearchMode = "auto",
    _debug = false,
    _offset = 0
  ): Promise<SearchResult[]> {
    this.lastSearchQuery = query;
    return [
      {
        id: "chunk-1",
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        headings: ["Lifecycle"],
        score: 0.9,
        lexicalScore: 0.8,
        trigramScore: 0.6,
        snippet: `${query} snippet`
      }
    ].slice(0, limit);
  }

  public async readSection(id: string): Promise<DocChunk | null> {
    if (id === "chunk-code") {
      return {
        id,
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        headings: ["Lifecycle"],
        body_text: "",
        code_text: "var code = true;",
        raw_text: "Raw text fallback",
        segments: [{ kind: "code", text: "var code = true;" }],
        order: 1,
        pageOrder: 1
      };
    }

    if (id === "chunk-raw") {
      return {
        id,
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        headings: ["Lifecycle"],
        body_text: "",
        code_text: "",
        raw_text: "Raw text only",
        segments: [{ kind: "prose", text: "Raw text only" }],
        order: 2,
        pageOrder: 2
      };
    }

    return {
      id,
      path: "/events/aggregate-projections.md",
      title: "Aggregate Projections",
      headings: ["Lifecycle"],
      body_text: "Lifecycle body",
      code_text: "example();",
      raw_text: "Longer raw text that should not win when body_text exists",
      segments: [
        { kind: "heading", text: "Lifecycle" },
        { kind: "prose", text: "Lifecycle body" },
        { kind: "code", text: "example();" }
      ],
      order: 0,
      pageOrder: 0
    };
  }

  public async readContext(id: string, _before = 1, _after = 1, _mode: ContextMode = "section"): Promise<DocChunk[]> {
    return [
      {
        id: `${id}-a`,
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        headings: ["Lifecycle"],
        body_text: "body a",
        code_text: "",
        raw_text: "raw a",
        order: 0,
        pageOrder: 0
      },
      {
        id: `${id}-b`,
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        headings: ["Lifecycle"],
        body_text: "body b",
        code_text: "",
        raw_text: "raw b",
        order: 1,
        pageOrder: 1
      }
    ];
  }

  public async getNeighbors(id: string, before = 1, after = 1): Promise<{ before: DocChunk[]; after: DocChunk[] }> {
    const chunks = [await this.readSection("chunk-1"), await this.readSection("chunk-code"), await this.readSection("chunk-raw")].filter(
      (value): value is DocChunk => value !== null
    );
    const idx = chunks.findIndex((chunk) => chunk.id === id);
    if (idx < 0) {
      return { before: [], after: [] };
    }

    return {
      before: chunks.slice(Math.max(0, idx - before), idx),
      after: chunks.slice(idx + 1, idx + 1 + after)
    };
  }

  public async listPages(_prefix = "", limit = 25): Promise<PageSummary[]> {
    return [
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        chunkCount: 2
      }
    ].slice(0, limit);
  }

  public async listHeadings(path: string): Promise<Array<{ headingKey: string; firstChunkId: string; chunkCount: number }>> {
    return [
      {
        headingKey: "Lifecycle",
        firstChunkId: `${path}::0`,
        chunkCount: 1
      }
    ];
  }

  public async searchWithinPage(
    _path: string,
    query: string,
    limit = 4,
    _mode: SearchMode = "auto",
    _debug = false,
    _offset = 0
  ): Promise<SearchResult[]> {
    this.lastSearchQuery = query;
    return this.searchDocs(query, limit);
  }

  public async getStatus(): Promise<StatusReport> {
    return FIXTURE_STATUS;
  }

  public async refresh(_force = false): Promise<{ refreshed: boolean; chunkCount: number; metadata: unknown }> {
    return {
      refreshed: true,
      chunkCount: 2,
      metadata: {
        sourceUrl: FIXTURE_STATUS.sourceUrl
      }
    };
  }
}
