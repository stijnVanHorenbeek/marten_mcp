import { HARD_TTL_MS, INDEX_VERSION, PARSER_VERSION, SOFT_TTL_MS, SOURCE_URL } from "./config.js";
import { DocsCache, cacheExistsOnDisk, computeFreshness } from "./cache.js";
import { HybridIndex, type QueryProfileInspection, inspectQueryProfile } from "./indexer.js";
import { logInfo } from "./logger.js";
import type {
  CacheMetadata,
  ContextMode,
  DocChunk,
  HeadingSummary,
  PageSummary,
  ParseDiagnostics,
  SearchMode,
  SearchResult,
  StatusReport
} from "./types.js";
import { clamp } from "./util.js";

export class DocsService {
  private readonly cache: DocsCache;
  private index: HybridIndex | null = null;
  private metadata: CacheMetadata | null = null;
  private parseDiagnostics: ParseDiagnostics | null = null;
  private rebuildQueue: Promise<void> = Promise.resolve();
  private backgroundRefreshRunning = false;
  private backgroundLastStartedAt: string | null = null;
  private backgroundLastFinishedAt: string | null = null;
  private backgroundLastResult: "updated" | "unchanged" | "failed" | null = null;

  public constructor(cache = new DocsCache()) {
    this.cache = cache;
  }

  public async initialize(): Promise<void> {
    await this.ensureIndex(false);
  }

  public async refresh(force = false): Promise<{ refreshed: boolean; chunkCount: number; metadata: CacheMetadata }> {
    return this.withRebuildLock(async () => {
      const beforeHash = this.metadata?.sha256 ?? null;
      const result = await this.cache.ensureReady({ force });
      this.metadata = result.metadata;
      this.parseDiagnostics = result.parseDiagnostics;
      this.index = result.indexState ? new HybridIndex(result.chunks, result.indexState) : new HybridIndex(result.chunks);
      const refreshed = beforeHash !== null ? beforeHash !== result.metadata.sha256 : true;

    return {
      refreshed,
      chunkCount: result.chunks.length,
      metadata: result.metadata
    };
    });
  }

  public async searchDocs(query: string, limit = 8, mode: SearchMode = "auto", debug = false, offset = 0): Promise<SearchResult[]> {
    await this.ensureIndex(false);
    const safeLimit = clamp(limit, 1, 25);
    const safeOffset = clamp(offset, 0, 2000);
    return this.index ? this.index.search(query, safeLimit, mode, debug, safeOffset) : [];
  }

  public inspectQueryProfile(query: string): QueryProfileInspection {
    return inspectQueryProfile(query);
  }

  public async readSection(id: string): Promise<DocChunk | null> {
    await this.ensureIndex(false);
    return this.index?.getById(id) ?? null;
  }

  public async readContext(id: string, before = 1, after = 1, mode: ContextMode = "section"): Promise<DocChunk[]> {
    await this.ensureIndex(false);
    const safeBefore = clamp(before, 0, 3);
    const safeAfter = clamp(after, 0, 3);
    return this.index?.getContext(id, safeBefore, safeAfter, mode) ?? [];
  }

  public async getNeighbors(id: string, before = 1, after = 1): Promise<{ before: DocChunk[]; after: DocChunk[] }> {
    await this.ensureIndex(false);
    const safeBefore = clamp(before, 0, 3);
    const safeAfter = clamp(after, 0, 3);
    return this.index?.getNeighbors(id, safeBefore, safeAfter) ?? { before: [], after: [] };
  }

  public async listHeadings(path: string): Promise<HeadingSummary[]> {
    await this.ensureIndex(false);
    return this.index?.listHeadings(path) ?? [];
  }

  public async searchWithinPage(
    path: string,
    query: string,
    limit = 6,
    mode: SearchMode = "auto",
    debug = false,
    offset = 0
  ): Promise<SearchResult[]> {
    await this.ensureIndex(false);
    const safeLimit = clamp(limit, 1, 20);
    const safeOffset = clamp(offset, 0, 500);
    return this.index ? this.index.searchWithinPage(path, query, safeLimit, mode, debug, safeOffset) : [];
  }

  public async listPages(prefix = "", limit = 25): Promise<PageSummary[]> {
    await this.ensureIndex(false);
    const safeLimit = clamp(limit, 1, 100);
    return this.index?.listPages(prefix, safeLimit) ?? [];
  }

  public async getPage(path: string): Promise<DocChunk[]> {
    await this.ensureIndex(false);
    return this.index?.getPage(path) ?? [];
  }

  public async getStatus(): Promise<StatusReport> {
    const hasCache = await cacheExistsOnDisk();
    const metadata = await this.cache.getMetadata();
    const lastValidationError = this.cache.getLastValidationError();
    const validationBackoff = this.cache.getValidationBackoffStatus();
    const validationFailureHistory = this.cache.getValidationFailureHistory();

    let freshnessState: StatusReport["freshness"]["state"] = "missing";
    let ageHours: number | null = null;

    if (metadata) {
      const freshness = computeFreshness(metadata);
      ageHours = msToHours(freshness.ageSinceValidationMs);
      if (freshness.isFreshWithinSoftTtl) {
        freshnessState = "fresh";
      } else if (freshness.isBeyondHardTtl) {
        freshnessState = "stale-hard";
      } else {
        freshnessState = "stale-soft";
      }
    }

    return {
      sourceUrl: SOURCE_URL,
      cachePath: this.cache.getCachePath(),
      storageMode: this.cache.getStorageMode(),
      hasCache,
      freshness: {
        state: freshnessState,
        softTtlHours: msToHours(SOFT_TTL_MS),
        hardTtlHours: msToHours(HARD_TTL_MS),
        ageSinceValidationHours: ageHours,
        lastValidationError,
        validationBackoff,
        validationFailureHistory,
        backgroundRefresh: {
          running: this.backgroundRefreshRunning,
          lastStartedAt: this.backgroundLastStartedAt,
          lastFinishedAt: this.backgroundLastFinishedAt,
          lastResult: this.backgroundLastResult
        }
      },
      metadata,
      index: {
        ready: this.index !== null,
        chunkCount: this.index?.chunkCount() ?? 0,
        pageCount: this.index?.pageCount() ?? 0,
        parserVersion: PARSER_VERSION,
        indexVersion: INDEX_VERSION,
        parseDiagnostics: this.parseDiagnostics
      }
    };
  }

  private async ensureIndex(force: boolean): Promise<void> {
    if (!force && this.index) {
      return;
    }

    await this.withRebuildLock(async () => {
      if (!force && this.index) {
        return;
      }

      const result = await this.cache.ensureReady({ force, allowStaleWhileRevalidate: !force });
      this.metadata = result.metadata;
      this.parseDiagnostics = result.parseDiagnostics;
      this.index = result.indexState ? new HybridIndex(result.chunks, result.indexState) : new HybridIndex(result.chunks);
      logInfo("Index ready", {
        chunkCount: result.chunks.length,
        staleFallback: result.usedStaleCacheDueToError
      });

      if (result.backgroundRevalidateRecommended) {
        this.scheduleBackgroundRefresh();
      }
    });
  }

  private scheduleBackgroundRefresh(): void {
    if (this.backgroundRefreshRunning) {
      return;
    }

    this.backgroundRefreshRunning = true;
    this.backgroundLastStartedAt = new Date().toISOString();

    void (async () => {
      try {
        const result = await this.refresh(false);
        this.backgroundLastResult = result.refreshed ? "updated" : "unchanged";
      } catch {
        this.backgroundLastResult = "failed";
      } finally {
        this.backgroundLastFinishedAt = new Date().toISOString();
        this.backgroundRefreshRunning = false;
      }
    })();
  }

  private async withRebuildLock<T>(operation: () => Promise<T>): Promise<T> {
    let releaseCurrent: () => void = () => {};
    const previous = this.rebuildQueue;
    this.rebuildQueue = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      releaseCurrent();
    }
  }
}

function msToHours(ms: number): number {
  return Math.round((ms / (60 * 60 * 1000)) * 100) / 100;
}
