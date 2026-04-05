import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createMcpServer } from "../src/mcpServer.js";
import type { ContextMode, DocChunk, PageSummary, SearchMode, SearchResult, StatusReport } from "../src/types.js";

describe("mcp schema enforcement", () => {
  test("rejects invalid tool inputs", async () => {
    const server = createMcpServer({ service: new FakeDocsService() });
    const harness = await connectClient(server);

    try {
      const invalidSearch = await harness.client.callTool({
        name: "search_docs",
        arguments: { query: "" }
      });
      expect(invalidSearch.isError).toBe(true);
      expect(extractText(invalidSearch)).toContain("Invalid arguments for tool search_docs");

      const invalidField = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-1", segmentIndex: -1 }
      });
      expect(invalidField.isError).toBe(true);
      expect(extractText(invalidField)).toContain("Invalid arguments for tool read_section");

      const invalidContext = await harness.client.callTool({
        name: "read_context",
        arguments: { id: "chunk-1", before: 99 }
      });
      expect(invalidContext.isError).toBe(true);
      expect(extractText(invalidContext)).toContain("Invalid arguments for tool read_context");
    } finally {
      await harness.close();
    }
  });

  test("accepts valid read_section output against schema", async () => {
    const server = createMcpServer({ service: new FakeDocsService() });
    const harness = await connectClient(server);

    try {
      const result = await harness.client.callTool({
        name: "read_section",
        arguments: { id: "chunk-1" }
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeTruthy();
    } finally {
      await harness.close();
    }
  });

  test("rejects invalid tool structured output against outputSchema", async () => {
    const server = new McpServer({ name: "schema-bad-output", version: "0.1.0" });

    server.registerTool(
      "bad_output",
      {
        description: "Returns invalid structured content",
        inputSchema: {
          noop: z.boolean().optional()
        },
        outputSchema: {
          value: z.string()
        }
      },
      async () => {
        return {
          content: [{ type: "text", text: "bad" }],
          structuredContent: {
            value: 42
          }
        };
      }
    );

    const harness = await connectClient(server);

    try {
      const result = await harness.client.callTool({
        name: "bad_output",
        arguments: {}
      });
      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Output validation error: Invalid structured content for tool bad_output");
    } finally {
      await harness.close();
    }
  });
});

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

async function connectClient(server: McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-schema-test", version: "0.1.0" }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.allSettled([server.close(), clientTransport.close(), serverTransport.close()]);
    }
  };
}

class FakeDocsService {
  public async initialize(): Promise<void> {}

  public async searchDocs(
    query: string,
    limit = 5,
    _mode: SearchMode = "auto",
    _debug = false,
    _offset = 0
  ): Promise<SearchResult[]> {
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
    return {
      id,
      path: "/events/aggregate-projections.md",
      title: "Aggregate Projections",
      headings: ["Lifecycle"],
      body_text: "Lifecycle body",
      code_text: "",
      raw_text: "Lifecycle body",
      segments: [{ kind: "prose", text: "Lifecycle body" }],
      order: 0,
      pageOrder: 0
    };
  }

  public async readContext(_id: string, _before = 1, _after = 1, _mode: ContextMode = "section"): Promise<DocChunk[]> {
    return [];
  }

  public async getNeighbors(_id: string, _before = 1, _after = 1): Promise<{ before: DocChunk[]; after: DocChunk[] }> {
    return { before: [], after: [] };
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

  public async getPage(_path: string): Promise<DocChunk[]> {
    return [];
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
    return this.searchDocs(query, limit);
  }

  public async getStatus(): Promise<StatusReport> {
    return {
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
  }

  public async refresh(_force = false): Promise<{ refreshed: boolean; chunkCount: number; metadata: unknown }> {
    return {
      refreshed: true,
      chunkCount: 2,
      metadata: {
        sourceUrl: "https://martendb.io/llms-full.txt"
      }
    };
  }
}
