/// <reference types="bun-types" />

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DocsCache } from "../src/cache.js";
import { resolveCachePaths } from "../src/config.js";
import type { CacheMetadata } from "../src/types.js";

const SAMPLE_DOCS_V1 = `---
url: /events/projections.md
---
# Projections

Use aggregate projections for event streams.

\`\`\`cs
var result = session.Query<User>();
\`\`\`
`;

const SAMPLE_DOCS_V2 = `---
url: /events/projections.md
---
# Projections

Updated content for projections.
`;

describe("docs cache revalidation", () => {
  let tempDir: string;
  let originalCacheDir: string | undefined;
  let originalStorageMode: string | undefined;
  let originalSqlitePath: string | undefined;
  let originalSqliteDriver: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-mcp-cache-"));
    originalCacheDir = process.env.MARTEN_MCP_CACHE_DIR;
    originalStorageMode = process.env.MARTEN_MCP_STORAGE_MODE;
    originalSqlitePath = process.env.MARTEN_MCP_SQLITE_PATH;
    originalSqliteDriver = process.env.MARTEN_MCP_SQLITE_DRIVER;
    process.env.MARTEN_MCP_CACHE_DIR = tempDir;
    process.env.MARTEN_MCP_STORAGE_MODE = "json";
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) {
      delete process.env.MARTEN_MCP_CACHE_DIR;
    } else {
      process.env.MARTEN_MCP_CACHE_DIR = originalCacheDir;
    }

    if (originalStorageMode === undefined) {
      delete process.env.MARTEN_MCP_STORAGE_MODE;
    } else {
      process.env.MARTEN_MCP_STORAGE_MODE = originalStorageMode;
    }

    if (originalSqlitePath === undefined) {
      delete process.env.MARTEN_MCP_SQLITE_PATH;
    } else {
      process.env.MARTEN_MCP_SQLITE_PATH = originalSqlitePath;
    }

    if (originalSqliteDriver === undefined) {
      delete process.env.MARTEN_MCP_SQLITE_DRIVER;
    } else {
      process.env.MARTEN_MCP_SQLITE_DRIVER = originalSqliteDriver;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("fetches and persists docs on first run (200)", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(SAMPLE_DOCS_V1, {
        status: 200,
        headers: {
          etag: '"v1"',
          "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
        }
      });
    }) as unknown as typeof fetch;

    const cache = new DocsCache();
    const result = await cache.ensureReady();

    expect(callCount).toBe(1);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.metadata.etag).toBe('"v1"');
    expect(result.metadata.lastModified).toBe("Wed, 01 Apr 2026 14:20:00 GMT");
    expect(result.usedStaleCacheDueToError).toBe(false);

    const persisted = await readMetadata();
    expect(persisted?.sha256).toBe(result.metadata.sha256);
    expect(persisted?.chunkCount).toBe(result.metadata.chunkCount);

    const paths = resolveCachePaths();
    const snapshotJson = await fs.readFile(paths.indexSnapshotFile, "utf8");
    const snapshot = JSON.parse(snapshotJson) as { sourceSha256: string; chunks: unknown[] };
    expect(snapshot.sourceSha256).toBe(result.metadata.sha256);
    expect(snapshot.chunks.length).toBeGreaterThan(0);
  });

  test("revalidates stale cache with conditional headers (304)", async () => {
    let fetchStage = 0;
    let ifNoneMatch: string | null = null;
    let ifModifiedSince: string | null = null;

    globalThis.fetch = (async (_input, init) => {
      fetchStage += 1;
      if (fetchStage === 1) {
        return new Response(SAMPLE_DOCS_V1, {
          status: 200,
          headers: {
            etag: '"v1"',
            "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
          }
        });
      }

      const headers = new Headers(init?.headers);
      ifNoneMatch = headers.get("If-None-Match");
      ifModifiedSince = headers.get("If-Modified-Since");
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const cache = new DocsCache();
    const first = await cache.ensureReady();
    await makeCacheStale();
    const staleTimestamp = Date.parse("2000-01-01T00:00:00.000Z");

    const second = await cache.ensureReady();
    expect(fetchStage).toBe(2);
    expect(String(ifNoneMatch)).toBe('"v1"');
    expect(String(ifModifiedSince)).toBe("Wed, 01 Apr 2026 14:20:00 GMT");
    expect(second.metadata.sha256).toBe(first.metadata.sha256);
    expect(Date.parse(second.metadata.lastValidatedAt)).toBeGreaterThan(staleTimestamp);
    expect(second.usedStaleCacheDueToError).toBe(false);
  });

  test("falls back to stale cache when validation fails", async () => {
    let fetchStage = 0;
    globalThis.fetch = (async () => {
      fetchStage += 1;
      if (fetchStage === 1) {
        return new Response(SAMPLE_DOCS_V2, {
          status: 200,
          headers: {
            etag: '"v2"',
            "last-modified": "Thu, 02 Apr 2026 12:00:00 GMT"
          }
        });
      }

      throw new Error("network unavailable");
    }) as unknown as typeof fetch;

    const cache = new DocsCache();
    const first = await cache.ensureReady();
    await makeCacheStale();

    const second = await cache.ensureReady();
    expect(fetchStage).toBe(2);
    expect(second.usedStaleCacheDueToError).toBe(true);
    expect(second.lastValidationError).toContain("network unavailable");
    expect(cache.getLastValidationError()).toContain("network unavailable");
    const history = cache.getValidationFailureHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.message).toContain("network unavailable");
    expect(second.metadata.sha256).toBe(first.metadata.sha256);
    expect(second.chunks.length).toBeGreaterThan(0);
  });

  test("applies revalidation backoff after failure and bypasses on force", async () => {
    let fetchStage = 0;
    globalThis.fetch = (async () => {
      fetchStage += 1;
      if (fetchStage === 1) {
        return new Response(SAMPLE_DOCS_V1, {
          status: 200,
          headers: {
            etag: '"v1"',
            "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
          }
        });
      }

      if (fetchStage === 2) {
        throw new Error("temporary outage");
      }

      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const cache = new DocsCache();
    await cache.ensureReady();
    await makeCacheStale();

    const failed = await cache.ensureReady();
    expect(failed.usedStaleCacheDueToError).toBe(true);
    expect(fetchStage).toBe(2);

    const backoff = cache.getValidationBackoffStatus();
    expect(backoff.active).toBe(true);
    expect(backoff.retryInSeconds).toBeGreaterThan(0);
    expect(backoff.consecutiveFailures).toBe(1);

    const skipped = await cache.ensureReady();
    expect(fetchStage).toBe(2);
    expect(skipped.usedStaleCacheDueToError).toBe(true);

    const forced = await cache.ensureReady({ force: true });
    expect(fetchStage).toBe(3);
    expect(forced.usedStaleCacheDueToError).toBe(false);
    expect(cache.getValidationBackoffStatus().active).toBe(false);
  });

  test("can serve stale immediately and recommend background revalidate", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(SAMPLE_DOCS_V1, {
        status: 200,
        headers: {
          etag: '"v1"',
          "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
        }
      });
    }) as unknown as typeof fetch;

    const cache = new DocsCache();
    await cache.ensureReady();
    await makeCacheStale();

    const result = await cache.ensureReady({ allowStaleWhileRevalidate: true });
    expect(fetchCount).toBe(1);
    expect(result.backgroundRevalidateRecommended).toBe(true);
    expect(result.usedStaleCacheDueToError).toBe(false);
  });

  test("persists validation failure history across cache instances", async () => {
    let fetchStage = 0;
    globalThis.fetch = (async () => {
      fetchStage += 1;
      if (fetchStage === 1) {
        return new Response(SAMPLE_DOCS_V1, {
          status: 200,
          headers: {
            etag: '"v1"',
            "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
          }
        });
      }

      throw new Error("dns timeout");
    }) as unknown as typeof fetch;

    const firstCache = new DocsCache();
    await firstCache.ensureReady();
    await makeCacheStale();
    await firstCache.ensureReady();
    expect(firstCache.getValidationFailureHistory()[0]?.message).toContain("dns timeout");

    const secondCache = new DocsCache();
    await secondCache.ensureReady();
    const history = secondCache.getValidationFailureHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.message).toContain("dns timeout");
  });

  test("tracks consecutive failures when force bypasses backoff", async () => {
    let fetchStage = 0;
    globalThis.fetch = (async () => {
      fetchStage += 1;
      if (fetchStage === 1) {
        return new Response(SAMPLE_DOCS_V1, {
          status: 200,
          headers: {
            etag: '"v1"',
            "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
          }
        });
      }

      throw new Error("socket reset");
    }) as unknown as typeof fetch;

    const cache = new DocsCache();
    await cache.ensureReady();
    await makeCacheStale();

    await cache.ensureReady({ force: true });
    await cache.ensureReady({ force: true });
    const backoff = cache.getValidationBackoffStatus();

    expect(backoff.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(backoff.active).toBe(true);
  });

  test("sqlite storage mode persists docs and metadata", async () => {
    process.env.MARTEN_MCP_STORAGE_MODE = "sqlite";
    process.env.MARTEN_MCP_SQLITE_DRIVER = "bun-sqlite";
    process.env.MARTEN_MCP_SQLITE_PATH = path.join(tempDir, "cache.db");

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(SAMPLE_DOCS_V1, {
        status: 200,
        headers: {
          etag: '"v1"',
          "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
        }
      });
    }) as unknown as typeof fetch;

    const first = new DocsCache();
    const firstResult = await first.ensureReady();
    expect(firstResult.metadata.etag).toBe('"v1"');

    const second = new DocsCache();
    const secondResult = await second.ensureReady();

    expect(fetchCount).toBe(1);
    expect(secondResult.metadata.sha256).toBe(firstResult.metadata.sha256);
    expect(secondResult.chunks.length).toBeGreaterThan(0);
  });
});

async function readMetadata(): Promise<CacheMetadata | null> {
  const paths = resolveCachePaths();
  try {
    const json = await fs.readFile(paths.metadataFile, "utf8");
    return JSON.parse(json) as CacheMetadata;
  } catch {
    return null;
  }
}

async function makeCacheStale(): Promise<void> {
  const paths = resolveCachePaths();
  const meta = await readMetadata();
  if (!meta) {
    throw new Error("metadata not found");
  }

  const stale = {
    ...meta,
    lastValidatedAt: "2000-01-01T00:00:00.000Z"
  };
  await fs.writeFile(paths.metadataFile, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
}
