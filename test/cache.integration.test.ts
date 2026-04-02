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
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-mcp-cache-"));
    originalCacheDir = process.env.MARTEN_MCP_CACHE_DIR;
    process.env.MARTEN_MCP_CACHE_DIR = tempDir;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) {
      delete process.env.MARTEN_MCP_CACHE_DIR;
    } else {
      process.env.MARTEN_MCP_CACHE_DIR = originalCacheDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("fetches and persists docs on first run (200)", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return new Response(SAMPLE_DOCS_V1, {
        status: 200,
        headers: {
          etag: '"v1"',
          "last-modified": "Wed, 01 Apr 2026 14:20:00 GMT"
        }
      });
    };

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
  });

  test("revalidates stale cache with conditional headers (304)", async () => {
    let fetchStage = 0;
    let ifNoneMatch: string | null = null;
    let ifModifiedSince: string | null = null;

    globalThis.fetch = async (_input, init) => {
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
    };

    const cache = new DocsCache();
    const first = await cache.ensureReady();
    await makeCacheStale();
    const staleTimestamp = Date.parse("2000-01-01T00:00:00.000Z");

    const second = await cache.ensureReady();
    expect(fetchStage).toBe(2);
    expect(ifNoneMatch).toBe('"v1"');
    expect(ifModifiedSince).toBe("Wed, 01 Apr 2026 14:20:00 GMT");
    expect(second.metadata.sha256).toBe(first.metadata.sha256);
    expect(Date.parse(second.metadata.lastValidatedAt)).toBeGreaterThan(staleTimestamp);
    expect(second.usedStaleCacheDueToError).toBe(false);
  });

  test("falls back to stale cache when validation fails", async () => {
    let fetchStage = 0;
    globalThis.fetch = async () => {
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
    };

    const cache = new DocsCache();
    const first = await cache.ensureReady();
    await makeCacheStale();

    const second = await cache.ensureReady();
    expect(fetchStage).toBe(2);
    expect(second.usedStaleCacheDueToError).toBe(true);
    expect(second.lastValidationError).toContain("network unavailable");
    expect(cache.getLastValidationError()).toContain("network unavailable");
    expect(second.metadata.sha256).toBe(first.metadata.sha256);
    expect(second.chunks.length).toBeGreaterThan(0);
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
