import fs from "node:fs/promises";
import path from "node:path";
import { HARD_TTL_MS, INDEX_VERSION, PARSER_VERSION, SOFT_TTL_MS, SOURCE_URL, resolveCachePaths } from "./config.js";
import { logInfo, logWarn } from "./logger.js";
import { chunkPages, parsePagesWithDiagnostics } from "./parser.js";
import type { CacheMetadata, DocChunk, FreshnessState, ParseDiagnostics } from "./types.js";
import { nowIso, sha256 } from "./util.js";

interface EnsureOptions {
  force?: boolean;
}

export interface EnsureResult {
  metadata: CacheMetadata;
  rawDocs: string;
  chunks: DocChunk[];
  parseDiagnostics: ParseDiagnostics;
  usedStaleCacheDueToError: boolean;
  lastValidationError: string | null;
}

export class DocsCache {
  private lastValidationError: string | null = null;

  public async ensureReady(options: EnsureOptions = {}): Promise<EnsureResult> {
    await this.ensureCacheDir();

    const existingMeta = await this.readMetadata();
    const existingDocs = await this.readDocs();

    if (!existingMeta || !existingDocs) {
      logInfo("Cache missing, performing full fetch");
      const fetched = await this.fetchAndBuild(null);
      this.lastValidationError = null;
      return {
        ...fetched,
        usedStaleCacheDueToError: false,
        lastValidationError: this.lastValidationError
      };
    }

    if (!options.force) {
      const freshness = computeFreshness(existingMeta);
      if (freshness.isFreshWithinSoftTtl) {
        const { chunks, parseDiagnostics } = this.buildChunks(existingDocs);
        return {
          metadata: existingMeta,
          rawDocs: existingDocs,
          chunks,
          parseDiagnostics,
          usedStaleCacheDueToError: false,
          lastValidationError: this.lastValidationError
        };
      }
    }

    try {
      const validated = await this.revalidate(existingMeta, existingDocs, options.force === true);
      this.lastValidationError = null;
      return {
        ...validated,
        usedStaleCacheDueToError: false,
        lastValidationError: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastValidationError = message;
      logWarn("Revalidation failed; using stale cache", { error: message });

      const { chunks, parseDiagnostics } = this.buildChunks(existingDocs);
      return {
        metadata: existingMeta,
        rawDocs: existingDocs,
        chunks,
        parseDiagnostics,
        usedStaleCacheDueToError: true,
        lastValidationError: this.lastValidationError
      };
    }
  }

  public getLastValidationError(): string | null {
    return this.lastValidationError;
  }

  public async getMetadata(): Promise<CacheMetadata | null> {
    return this.readMetadata();
  }

  public getCachePath(): string {
    return resolveCachePaths().dir;
  }

  private async revalidate(
    existingMeta: CacheMetadata,
    existingDocs: string,
    force: boolean
  ): Promise<{ metadata: CacheMetadata; rawDocs: string; chunks: DocChunk[]; parseDiagnostics: ParseDiagnostics }> {
    const headers = new Headers();
    if (!force) {
      if (existingMeta.etag) {
        headers.set("If-None-Match", existingMeta.etag);
      }
      if (existingMeta.lastModified) {
        headers.set("If-Modified-Since", existingMeta.lastModified);
      }
    }

    const response = await fetch(SOURCE_URL, {
      method: "GET",
      headers
    });

    if (response.status === 304) {
      const updatedMeta: CacheMetadata = {
        ...existingMeta,
        lastValidatedAt: nowIso()
      };
      await this.writeMetadata(updatedMeta);
      const { chunks, parseDiagnostics } = this.buildChunks(existingDocs);
      return {
        metadata: updatedMeta,
        rawDocs: existingDocs,
        chunks,
        parseDiagnostics
      };
    }

    if (!response.ok) {
      throw new Error(`Unexpected status code during refresh: ${response.status}`);
    }

    const body = await response.text();
    const newSha = sha256(body);
    const unchangedByHash = newSha === existingMeta.sha256;
    if (unchangedByHash) {
      const updatedMeta: CacheMetadata = {
        ...existingMeta,
        lastValidatedAt: nowIso(),
        etag: response.headers.get("etag") ?? existingMeta.etag,
        lastModified: response.headers.get("last-modified") ?? existingMeta.lastModified
      };
      await this.writeMetadata(updatedMeta);

      const { chunks, parseDiagnostics } = this.buildChunks(existingDocs);
      return {
        metadata: updatedMeta,
        rawDocs: existingDocs,
        chunks,
        parseDiagnostics
      };
    }

    return this.persistFetchedDocs(body, response.headers.get("etag"), response.headers.get("last-modified"));
  }

  private async fetchAndBuild(
    _existingMeta: CacheMetadata | null
  ): Promise<{ metadata: CacheMetadata; rawDocs: string; chunks: DocChunk[]; parseDiagnostics: ParseDiagnostics }> {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch docs: ${response.status}`);
    }

    const body = await response.text();
    return this.persistFetchedDocs(body, response.headers.get("etag"), response.headers.get("last-modified"));
  }

  private async persistFetchedDocs(
    body: string,
    etag: string | null,
    lastModified: string | null
  ): Promise<{ metadata: CacheMetadata; rawDocs: string; chunks: DocChunk[]; parseDiagnostics: ParseDiagnostics }> {
    const { chunks, parseDiagnostics } = this.buildChunks(body);
    const now = nowIso();
    const metadata: CacheMetadata = {
      sourceUrl: SOURCE_URL,
      fetchedAt: now,
      lastValidatedAt: now,
      etag,
      lastModified,
      sha256: sha256(body),
      chunkCount: chunks.length,
      parserVersion: PARSER_VERSION,
      indexVersion: INDEX_VERSION
    };

    await this.writeDocs(body);
    await this.writeMetadata(metadata);

    return {
      metadata,
      rawDocs: body,
      chunks,
      parseDiagnostics
    };
  }

  private buildChunks(rawDocs: string): { chunks: DocChunk[]; parseDiagnostics: ParseDiagnostics } {
    const parsed = parsePagesWithDiagnostics(rawDocs);
    return {
      chunks: chunkPages(parsed.pages),
      parseDiagnostics: parsed.diagnostics
    };
  }

  private async ensureCacheDir(): Promise<void> {
    const paths = resolveCachePaths();
    await fs.mkdir(paths.dir, { recursive: true });
  }

  private async readDocs(): Promise<string | null> {
    const paths = resolveCachePaths();
    try {
      return await fs.readFile(paths.docsFile, "utf8");
    } catch {
      return null;
    }
  }

  private async writeDocs(raw: string): Promise<void> {
    const paths = resolveCachePaths();
    await fs.writeFile(paths.docsFile, raw, "utf8");
  }

  private async readMetadata(): Promise<CacheMetadata | null> {
    const paths = resolveCachePaths();
    try {
      const json = await fs.readFile(paths.metadataFile, "utf8");
      return JSON.parse(json) as CacheMetadata;
    } catch {
      return null;
    }
  }

  private async writeMetadata(meta: CacheMetadata): Promise<void> {
    const paths = resolveCachePaths();
    await fs.writeFile(paths.metadataFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }
}

export function computeFreshness(metadata: CacheMetadata): FreshnessState {
  const now = Date.now();
  const lastValidated = Date.parse(metadata.lastValidatedAt);
  const age = Number.isFinite(lastValidated) ? Math.max(0, now - lastValidated) : HARD_TTL_MS + 1;

  return {
    isFreshWithinSoftTtl: age <= SOFT_TTL_MS,
    isBeyondHardTtl: age > HARD_TTL_MS,
    softTtlMs: SOFT_TTL_MS,
    hardTtlMs: HARD_TTL_MS,
    ageSinceValidationMs: age
  };
}

export async function cacheExistsOnDisk(): Promise<boolean> {
  const p = resolveCachePaths();
  try {
    await fs.access(path.dirname(p.metadataFile));
    await fs.access(p.docsFile);
    await fs.access(p.metadataFile);
    return true;
  } catch {
    return false;
  }
}
