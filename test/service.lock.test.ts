import { describe, expect, test } from "bun:test";
import type { DocsCache, EnsureResult } from "../src/cache.js";
import { DocsService } from "../src/service.js";

describe("service rebuild lock", () => {
  test("serializes concurrent refresh operations", async () => {
    const cache = new MockCache();
    const service = new DocsService(cache as unknown as DocsCache);

    await Promise.all([service.refresh(true), service.refresh(true), service.refresh(true)]);

    expect(cache.callCount).toBe(3);
    expect(cache.maxConcurrentCalls).toBe(1);
  });

  test("initializes from stale cache and triggers one background refresh", async () => {
    const cache = new MockCache({ recommendBackgroundOnFirstCall: true });
    const service = new DocsService(cache as unknown as DocsCache);

    await service.initialize();
    await sleep(60);

    expect(cache.callCount).toBe(2);
    expect(cache.maxConcurrentCalls).toBe(1);

    const status = await service.getStatus();
    expect(status.freshness.backgroundRefresh.lastResult).toBeTruthy();
    expect(status.freshness.backgroundRefresh.running).toBe(false);
  });
});

class MockCache {
  public callCount = 0;
  public concurrentCalls = 0;
  public maxConcurrentCalls = 0;
  private readonly recommendBackgroundOnFirstCall: boolean;

  public constructor(options: { recommendBackgroundOnFirstCall?: boolean } = {}) {
    this.recommendBackgroundOnFirstCall = options.recommendBackgroundOnFirstCall ?? false;
  }

  public async ensureReady(): Promise<EnsureResult> {
    this.callCount += 1;
    this.concurrentCalls += 1;
    this.maxConcurrentCalls = Math.max(this.maxConcurrentCalls, this.concurrentCalls);

    await sleep(25);

    this.concurrentCalls -= 1;
    return buildEnsureResult(this.callCount, {
      backgroundRevalidateRecommended: this.recommendBackgroundOnFirstCall && this.callCount === 1
    });
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
    return buildEnsureResult(this.callCount).metadata;
  }

  public getCachePath(): string {
    return "/tmp/mock-cache";
  }
}

function buildEnsureResult(seq: number, overrides: Partial<EnsureResult> = {}): EnsureResult {
  const base: EnsureResult = {
    metadata: {
      sourceUrl: "https://example.com/llms-full.txt",
      fetchedAt: "2026-04-02T00:00:00.000Z",
      lastValidatedAt: "2026-04-02T00:00:00.000Z",
      etag: `"etag-${seq}"`,
      lastModified: null,
      sha256: `sha-${seq}`,
      chunkCount: 1,
      parserVersion: "v1",
      indexVersion: "v1"
    },
    rawDocs: "mock docs",
    chunks: [
      {
        id: `/mock/${seq}::0`,
        path: `/mock/${seq}`,
        title: "Mock",
        headings: ["Mock"],
        body_text: "mock body",
        code_text: "",
        raw_text: "mock body",
        order: 0,
        pageOrder: 0
      }
    ],
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

  return {
    ...base,
    ...overrides
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
