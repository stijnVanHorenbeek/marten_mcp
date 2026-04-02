import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DocsService } from "./service.js";
import type { SearchMode } from "./types.js";

const SEARCH_MODES = ["auto", "lexical", "trigram", "exact"] as const;

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
      mode: z.enum(SEARCH_MODES).optional()
    },
    async ({ query, limit, mode }: { query: string; limit?: number; mode?: SearchMode }) => {
      const results = await service.searchDocs(query, limit ?? 8, (mode ?? "auto") as SearchMode);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ query, mode: mode ?? "auto", count: results.length, results }, null, 2)
          }
        ]
      };
    }
  );

  server.tool(
    "read_section",
    {
      id: z.string().min(1)
    },
    async ({ id }: { id: string }) => {
      const chunk = await service.readSection(id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              chunk ?? {
                error: "not_found",
                id
              },
              null,
              2
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
      before: z.number().int().min(0).max(10).optional(),
      after: z.number().int().min(0).max(10).optional()
    },
    async ({ id, before, after }: { id: string; before?: number; after?: number }) => {
      const context = await service.readContext(id, before ?? 1, after ?? 1);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id,
                before: before ?? 1,
                after: after ?? 1,
                count: context.length,
                chunks: context
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.tool(
    "read_page",
    {
      path: z.string().min(1),
      maxChunks: z.number().int().min(1).max(30).optional()
    },
    async ({ path, maxChunks }: { path: string; maxChunks?: number }) => {
      const chunks = await service.readPage(path, maxChunks ?? 12);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path,
                count: chunks.length,
                chunks
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.tool("get_status", {}, async () => {
    const status = await service.getStatus();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(status, null, 2)
        }
      ]
    };
  });

  server.tool(
    "refresh_docs",
    {
      force: z.boolean().optional()
    },
    async ({ force }: { force?: boolean }) => {
      const result = await service.refresh(force ?? false);
      const status = await service.getStatus();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                refreshed: result.refreshed,
                force: force ?? false,
                chunkCount: result.chunkCount,
                metadata: result.metadata,
                status
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
