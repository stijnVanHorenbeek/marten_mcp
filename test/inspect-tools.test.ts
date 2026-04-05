import { describe, expect, test } from "bun:test";
import { inspectChunk } from "../scripts/inspect-chunk.ts";
import { inspectQuery } from "../scripts/inspect-query.ts";
import type { QueryProfileInspection } from "../src/indexer.js";
import type { DocChunk, SearchResult } from "../src/types.js";

describe("inspect tools", () => {
  test("inspect chunk prints metadata and context", async () => {
    const service = new FakeInspectService();
    const output = await inspectChunk(
      {
        id: "chunk-1",
        context: 1,
        bodyOnly: false,
        codeOnly: false,
        rawOnly: false
      },
      service
    );

    expect(output).toContain("Chunk: chunk-1");
    expect(output).toContain("Lengths: body=");
    expect(output).toContain("== body_text ==");
    expect(output).toContain("== code_text ==");
    expect(output).toContain("== raw_text ==");
    expect(output).toContain("== context (+/-1) ==");
    expect(output).toContain("- chunk-2");
  });

  test("inspect chunk throws when missing", async () => {
    const service = new FakeInspectService();
    await expect(
      inspectChunk(
        {
          id: "missing-chunk",
          context: 0,
          bodyOnly: false,
          codeOnly: false,
          rawOnly: false
        },
        service
      )
    ).rejects.toThrow("Chunk not found: missing-chunk");
  });

  test("inspect query lists ranked results", async () => {
    const service = new FakeInspectService();
    const output = await inspectQuery(
      {
        query: "LoadManyAsync",
        limit: 5,
        showProfile: false,
        showPageChunks: false
      },
      service
    );

    expect(output).toContain("Query: LoadManyAsync");
    expect(output).toContain("Results: 2");
    expect(output).toContain("1) [0.910] chunk-1");
    expect(output).toContain("snippet:");
  });

  test("inspect query path-scoped search and page chunks", async () => {
    const service = new FakeInspectService();
    const output = await inspectQuery(
      {
        query: "lifecycle",
        limit: 3,
        path: "/events/projections/enrichment.md",
        showProfile: false,
        showPageChunks: true
      },
      service
    );

    expect(output).toContain("Path scope: /events/projections/enrichment.md");
    expect(output).toContain("== page chunks (/events/projections/enrichment.md) ==");
    expect(output).toContain("chunk-2");
    expect(output).toContain("path: /events/projections/enrichment.md");
  });

  test("inspect query shows query profile", async () => {
    const service = new FakeInspectService();
    const output = await inspectQuery(
      {
        query: "LoadManyAsync null missing ids returns null entries",
        limit: 5,
        showProfile: true,
        showPageChunks: false
      },
      service
    );

    expect(output).toContain("== query profile ==");
    expect(output).toContain("queryClass:");
    expect(output).toContain("lexicalTerms:");
    expect(output).toContain("identifierTerms:");
    expect(output).toContain("suppressedTerms:");
  });
});

class FakeInspectService {
  public async initialize(): Promise<void> {}

  public async readSection(id: string): Promise<DocChunk | null> {
    if (id === "missing-chunk") {
      return null;
    }

    if (id === "chunk-2") {
      return {
        id,
        path: "/events/projections/enrichment.md",
        title: "Enriching Events",
        headings: ["Projection lifecycle"],
        body_text: "Enrichment prose",
        code_text: "public class UserTaskProjection {}",
        raw_text: "Enrichment prose\npublic class UserTaskProjection {}",
        order: 1,
        pageOrder: 1
      };
    }

    return {
      id,
      path: "/documents/querying/byid.md",
      title: "Loading Documents by Id",
      headings: ["Load methods"],
      body_text: "Load single and many docs",
      code_text: "await session.LoadManyAsync<User>(ids)",
      raw_text: "Load docs and code sample",
      order: 0,
      pageOrder: 0
    };
  }

  public async readContext(_id: string): Promise<DocChunk[]> {
    return [await this.readSection("chunk-1"), await this.readSection("chunk-2")].filter(
      (value): value is DocChunk => value !== null
    );
  }

  public async searchDocs(_query: string): Promise<SearchResult[]> {
    return [
      {
        id: "chunk-1",
        path: "/documents/querying/byid.md",
        title: "Loading Documents by Id",
        headings: ["Load methods"],
        score: 0.91,
        lexicalScore: 0.7,
        trigramScore: 0.4,
        snippet: "LoadManyAsync example"
      },
      {
        id: "chunk-2",
        path: "/events/projections/enrichment.md",
        title: "Enriching Events",
        headings: ["Projection lifecycle"],
        score: 0.72,
        lexicalScore: 0.5,
        trigramScore: 0.3,
        snippet: "Lifecycle hook"
      }
    ];
  }

  public async searchWithinPage(path: string, _query: string): Promise<SearchResult[]> {
    return [
      {
        id: "chunk-2",
        path,
        title: "Enriching Events",
        headings: ["Projection lifecycle"],
        score: 0.83,
        lexicalScore: 0.6,
        trigramScore: 0.2,
        snippet: "Lifecycle details"
      }
    ];
  }

  public async getPage(path: string): Promise<DocChunk[]> {
    return [
      {
        id: "chunk-2",
        path,
        title: "Enriching Events",
        headings: ["Projection lifecycle"],
        body_text: "Enrichment prose",
        code_text: "public class UserTaskProjection {}",
        raw_text: "Enrichment prose\npublic class UserTaskProjection {}",
        order: 1,
        pageOrder: 1
      }
    ];
  }

  public inspectQueryProfile(_query: string): QueryProfileInspection {
    return {
      queryClass: "lexical",
      lexicalTerms: ["loadmanyasync", "entries"],
      identifierTerms: ["loadmanyasync"],
      suppressedTerms: ["missing", "null", "returns"],
      shortQuery: false,
      symbolHeavy: false
    };
  }
}
