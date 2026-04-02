import fs from "node:fs/promises";
import path from "node:path";
import {
  HARD_TTL_MS,
  INDEX_VERSION,
  PARSER_VERSION,
  SOFT_TTL_MS,
  SOURCE_URL,
  resolveCachePaths,
  resolveStorageMode
} from "./config.js";
import { logInfo, logWarn } from "./logger.js";
import { chunkPages, parsePagesWithDiagnostics } from "./parser.js";
import { createDefaultStorage, type CacheStorage } from "./storage.js";
import type {
  CacheMetadata,
  DocChunk,
  FreshnessState,
  ParseDiagnostics,
  ValidationFailureRecord,
  IndexSnapshotRecord,
  StorageMode
} from "./types.js";
import { nowIso, sha256 } from "./util.js";

interface EnsureOptions {
  force?: boolean;
  allowStaleWhileRevalidate?: boolean;
}

interface ValidationBackoffState {
  consecutiveFailures: number;
  nextRetryAtMs: number | null;
}

interface ValidationBackoffStatus {
  active: boolean;
  retryInSeconds: number | null;
  consecutiveFailures: number;
}

const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const BACKOFF_JITTER_RATIO = 0.2;
const MAX_VALIDATION_FAILURE_HISTORY = 20;

export interface EnsureResult {
  metadata: CacheMetadata;
  rawDocs: string;
  chunks: DocChunk[];
  parseDiagnostics: ParseDiagnostics;
  backgroundRevalidateRecommended: boolean;
  usedStaleCacheDueToError: boolean;
  lastValidationError: string | null;
}

export class DocsCache {
  private lastValidationError: string | null = null;
  private validationFailureHistory: ValidationFailureRecord[] = [];
  private validationHistoryLoaded = false;
  private storagePromise: Promise<CacheStorage>;
  private cachePath: string;
  private storageMode: StorageMode;
  private validationBackoff: ValidationBackoffState = {
    consecutiveFailures: 0,
    nextRetryAtMs: null
  };

  public constructor(storage?: CacheStorage) {
    this.cachePath = resolveCachePaths().dir;
    this.storageMode = resolveStorageMode();
    this.storagePromise = storage ? Promise.resolve(storage) : createDefaultStorage();
  }

  public async ensureReady(options: EnsureOptions = {}): Promise<EnsureResult> {
    const storage = await this.getStorage();
    await storage.ensureReady();
    await this.loadValidationHistoryOnce();

    const existingMeta = await storage.readMetadata();
    const existingDocs = await storage.readDocs();

    if (!existingMeta || !existingDocs) {
      logInfo("Cache missing, performing full fetch");
      const fetched = await this.fetchAndBuild(null);
      this.lastValidationError = null;
      return {
        ...fetched,
        backgroundRevalidateRecommended: false,
        usedStaleCacheDueToError: false,
        lastValidationError: this.lastValidationError
      };
    }

    if (!options.force) {
      const freshness = computeFreshness(existingMeta);
      if (freshness.isFreshWithinSoftTtl) {
        const { chunks, parseDiagnostics } = await this.buildChunksWithSnapshot(existingMeta, existingDocs);
        return {
          metadata: existingMeta,
          rawDocs: existingDocs,
          chunks,
          parseDiagnostics,
          backgroundRevalidateRecommended: false,
          usedStaleCacheDueToError: false,
          lastValidationError: this.lastValidationError
        };
      }

      if (options.allowStaleWhileRevalidate === true) {
        const backoff = this.getValidationBackoffStatus();
        const { chunks, parseDiagnostics } = await this.buildChunksWithSnapshot(existingMeta, existingDocs);
        return {
          metadata: existingMeta,
          rawDocs: existingDocs,
          chunks,
          parseDiagnostics,
          backgroundRevalidateRecommended: !backoff.active,
          usedStaleCacheDueToError: false,
          lastValidationError: this.lastValidationError
        };
      }

      if (this.shouldSkipValidationDueToBackoff()) {
        const { chunks, parseDiagnostics } = await this.buildChunksWithSnapshot(existingMeta, existingDocs);
        return {
          metadata: existingMeta,
          rawDocs: existingDocs,
          chunks,
          parseDiagnostics,
          backgroundRevalidateRecommended: false,
          usedStaleCacheDueToError: true,
          lastValidationError: this.lastValidationError
        };
      }
    }

    try {
      const validated = await this.revalidate(existingMeta, existingDocs, options.force === true);
      this.lastValidationError = null;
      this.clearValidationBackoff();
      return {
        ...validated,
        backgroundRevalidateRecommended: false,
        usedStaleCacheDueToError: false,
        lastValidationError: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastValidationError = message;
      await this.recordValidationFailure(message);
      const backoff = this.applyValidationBackoff();
      logWarn("Revalidation failed; using stale cache", {
        error: message,
        consecutiveFailures: backoff.consecutiveFailures,
        retryInSeconds: backoff.retryInSeconds
      });

      const { chunks, parseDiagnostics } = await this.buildChunksWithSnapshot(existingMeta, existingDocs);
      return {
        metadata: existingMeta,
        rawDocs: existingDocs,
        chunks,
        parseDiagnostics,
        backgroundRevalidateRecommended: false,
        usedStaleCacheDueToError: true,
        lastValidationError: this.lastValidationError
      };
    }
  }

  public getLastValidationError(): string | null {
    return this.lastValidationError;
  }

  public async getMetadata(): Promise<CacheMetadata | null> {
    const storage = await this.getStorage();
    return storage.readMetadata();
  }

  public getValidationBackoffStatus(): ValidationBackoffStatus {
    const now = Date.now();
    const nextRetryAtMs = this.validationBackoff.nextRetryAtMs;
    const active = nextRetryAtMs !== null && now < nextRetryAtMs;
    const retryInSeconds = active ? Math.ceil((nextRetryAtMs - now) / 1000) : null;

    return {
      active,
      retryInSeconds,
      consecutiveFailures: this.validationBackoff.consecutiveFailures
    };
  }

  public getValidationFailureHistory(): ValidationFailureRecord[] {
    return [...this.validationFailureHistory];
  }

  public getCachePath(): string {
    return this.cachePath;
  }

  public getStorageMode(): StorageMode {
    return this.storageMode;
  }

  private shouldSkipValidationDueToBackoff(): boolean {
    const backoff = this.getValidationBackoffStatus();
    if (!backoff.active) {
      return false;
    }

    logInfo("Skipping revalidation due to active backoff", {
      retryInSeconds: backoff.retryInSeconds,
      consecutiveFailures: backoff.consecutiveFailures
    });
    return true;
  }

  private clearValidationBackoff(): void {
    this.validationBackoff = {
      consecutiveFailures: 0,
      nextRetryAtMs: null
    };
  }

  private applyValidationBackoff(): ValidationBackoffStatus {
    const nextFailureCount = this.validationBackoff.consecutiveFailures + 1;
    const exponentialMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (nextFailureCount - 1));
    const jitterMultiplier = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER_RATIO;
    const jitteredMs = Math.max(BACKOFF_BASE_MS, Math.round(exponentialMs * jitterMultiplier));
    this.validationBackoff = {
      consecutiveFailures: nextFailureCount,
      nextRetryAtMs: Date.now() + jitteredMs
    };

    return this.getValidationBackoffStatus();
  }

  private async loadValidationHistoryOnce(): Promise<void> {
    if (this.validationHistoryLoaded) {
      return;
    }

    this.validationFailureHistory = await this.readValidationHistory();
    this.validationHistoryLoaded = true;
  }

  private async recordValidationFailure(message: string): Promise<void> {
    const entry: ValidationFailureRecord = {
      at: nowIso(),
      message
    };

    this.validationFailureHistory = [entry, ...this.validationFailureHistory].slice(0, MAX_VALIDATION_FAILURE_HISTORY);
    await this.writeValidationHistory(this.validationFailureHistory);
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
      const storage = await this.getStorage();
      await storage.writeMetadata(updatedMeta);
      const { chunks, parseDiagnostics } = await this.buildChunksWithSnapshot(updatedMeta, existingDocs);
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
      const storage = await this.getStorage();
      await storage.writeMetadata(updatedMeta);

      const { chunks, parseDiagnostics } = await this.buildChunksWithSnapshot(updatedMeta, existingDocs);
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

    const storage = await this.getStorage();
    await storage.writeDocs(body);
    await storage.writeMetadata(metadata);
    await storage.writeIndexSnapshot({
      createdAt: now,
      sourceSha256: metadata.sha256,
      parserVersion: PARSER_VERSION,
      indexVersion: INDEX_VERSION,
      chunks,
      parseDiagnostics
    });

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

  private async buildChunksWithSnapshot(
    metadata: CacheMetadata,
    rawDocs: string
  ): Promise<{ chunks: DocChunk[]; parseDiagnostics: ParseDiagnostics }> {
    const storage = await this.getStorage();
    const rawSha = sha256(rawDocs);
    if (rawSha !== metadata.sha256) {
      logWarn("Cache docs hash mismatch; rebuilding chunks from docs", {
        expectedSha: metadata.sha256,
        actualSha: rawSha
      });
      const rebuilt = this.buildChunks(rawDocs);
      await storage.writeIndexSnapshot({
        createdAt: nowIso(),
        sourceSha256: rawSha,
        parserVersion: PARSER_VERSION,
        indexVersion: INDEX_VERSION,
        chunks: rebuilt.chunks,
        parseDiagnostics: rebuilt.parseDiagnostics
      });
      return rebuilt;
    }

    const snapshot = await storage.readIndexSnapshot();
    if (
      snapshot &&
      snapshot.sourceSha256 === metadata.sha256 &&
      snapshot.parserVersion === PARSER_VERSION &&
      snapshot.indexVersion === INDEX_VERSION
    ) {
      return {
        chunks: snapshot.chunks,
        parseDiagnostics: snapshot.parseDiagnostics
      };
    }

    const rebuilt = this.buildChunks(rawDocs);
    await storage.writeIndexSnapshot({
      createdAt: nowIso(),
      sourceSha256: metadata.sha256,
      parserVersion: PARSER_VERSION,
      indexVersion: INDEX_VERSION,
      chunks: rebuilt.chunks,
      parseDiagnostics: rebuilt.parseDiagnostics
    });
    return rebuilt;
  }

  private async readValidationHistory(): Promise<ValidationFailureRecord[]> {
    const storage = await this.getStorage();
    const history = await storage.readValidationHistory();
    return history.slice(0, MAX_VALIDATION_FAILURE_HISTORY);
  }

  private async writeValidationHistory(history: ValidationFailureRecord[]): Promise<void> {
    const storage = await this.getStorage();
    await storage.writeValidationHistory(history);
  }

  private async getStorage(): Promise<CacheStorage> {
    const storage = await this.storagePromise;
    this.cachePath = storage.getCachePath();
    this.storageMode = storage.getStorageMode();
    return storage;
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
    if (resolveStorageMode() === "sqlite") {
      await fs.access(p.sqliteFile);
    } else {
      await fs.access(p.docsFile);
      await fs.access(p.metadataFile);
    }
    return true;
  } catch {
    return false;
  }
}
