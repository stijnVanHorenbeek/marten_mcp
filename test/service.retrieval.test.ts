import { describe, expect, test } from "bun:test";
import type { DocsCache, EnsureResult } from "../src/cache.js";
import { DocsService } from "../src/service.js";
import type { DocChunk } from "../src/types.js";

describe("retrieval discipline bounds", () => {
  test("readContext clamps broad section windows", async () => {
    const chunks: DocChunk[] = [];
    for (let i = 0; i < 9; i++) {
      chunks.push({
        id: `/events/projections.md::${i}`,
        path: "/events/projections.md",
        title: "Projections",
        headings: ["Lifecycle"],
        body_text: `lifecycle ${i}`,
        code_text: "",
        raw_text: `lifecycle ${i}`,
        order: i,
        pageOrder: i
      });
    }

    const service = new DocsService(new FixedCache(chunks) as unknown as DocsCache);
    const context = await service.readContext(chunks[4]!.id, 99, 99, "section");

    expect(context.length).toBe(7);
    expect(context[0]?.id).toBe(chunks[1]?.id);
    expect(context[6]?.id).toBe(chunks[7]?.id);
  });

  test("listPages clamps high limits", async () => {
    const chunks: DocChunk[] = [];
    for (let i = 0; i < 130; i++) {
      chunks.push({
        id: `/docs/page-${i}.md::0`,
        path: `/docs/page-${i}.md`,
        title: `Page ${i}`,
        headings: ["Top"],
        body_text: `body ${i}`,
        code_text: "",
        raw_text: `body ${i}`,
        order: 0,
        pageOrder: 0
      });
    }

    const service = new DocsService(new FixedCache(chunks) as unknown as DocsCache);
    const pages = await service.listPages("/docs", 500);

    expect(pages.length).toBe(100);
  });

  test("searchWithinPage supports offset paging", async () => {
    const chunks: DocChunk[] = [
      {
        id: "/events/aggregate.md::0",
        path: "/events/aggregate.md",
        title: "Aggregate",
        headings: ["Lifecycle"],
        body_text: "aggregate projections lifecycle",
        code_text: "",
        raw_text: "aggregate projections lifecycle",
        order: 0,
        pageOrder: 0
      },
      {
        id: "/events/aggregate.md::1",
        path: "/events/aggregate.md",
        title: "Aggregate",
        headings: ["Runtime"],
        body_text: "aggregate projections runtime",
        code_text: "",
        raw_text: "aggregate projections runtime",
        order: 1,
        pageOrder: 1
      }
    ];

    const service = new DocsService(new FixedCache(chunks) as unknown as DocsCache);
    const first = await service.searchWithinPage("/events/aggregate.md", "aggregate projections", 1, "auto", false, 0);
    const second = await service.searchWithinPage("/events/aggregate.md", "aggregate projections", 1, "auto", false, 1);

    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });
});

class FixedCache {
  private readonly chunks: DocChunk[];

  public constructor(chunks: DocChunk[]) {
    this.chunks = chunks;
  }

  public async ensureReady(): Promise<EnsureResult> {
    return buildEnsureResult(this.chunks);
  }

  public getLastValidationError(): string | null {
    return null;
  }

  public getValidationBackoffStatus(): { active: boolean; retryInSeconds: number | null; consecutiveFailures: number } {
    return {
      active: false,
      retryInSeconds: null,
      consecutiveFailures: 0
    };
  }

  public getValidationFailureHistory(): Array<{ at: string; message: string }> {
    return [];
  }

  public async getMetadata(): Promise<EnsureResult["metadata"]> {
    return buildEnsureResult(this.chunks).metadata;
  }

  public getCachePath(): string {
    return "/tmp/mock-cache";
  }

  public getStorageMode(): "json" {
    return "json";
  }
}

function buildEnsureResult(chunks: DocChunk[]): EnsureResult {
  return {
    metadata: {
      sourceUrl: "https://example.com/llms-full.txt",
      fetchedAt: "2026-04-02T00:00:00.000Z",
      lastValidatedAt: "2026-04-02T00:00:00.000Z",
      etag: '"etag-1"',
      lastModified: null,
      sha256: "sha-1",
      chunkCount: chunks.length,
      parserVersion: "v1",
      indexVersion: "v1"
    },
    rawDocs: "mock docs",
    chunks,
    parseDiagnostics: {
      mode: "strict",
      pageMarkerCount: 1,
      malformedMarkerCount: 0,
      warnings: []
    },
    backgroundRevalidateRecommended: false,
    usedStaleCacheDueToError: false,
    lastValidationError: null
  };
}
