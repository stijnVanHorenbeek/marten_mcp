import { HARD_TTL_MS, INDEX_VERSION, PARSER_VERSION, SOFT_TTL_MS, SOURCE_URL } from "./config.js";
import { DocsCache, cacheExistsOnDisk, computeFreshness } from "./cache.js";
import { HybridIndex } from "./indexer.js";
import { logInfo } from "./logger.js";
import type {
  CacheMetadata,
  ContextMode,
  DocChunk,
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

  public constructor(cache = new DocsCache()) {
    this.cache = cache;
  }

  public async initialize(): Promise<void> {
    await this.ensureIndex(false);
  }

  public async refresh(force = false): Promise<{ refreshed: boolean; chunkCount: number; metadata: CacheMetadata }> {
    const beforeHash = this.metadata?.sha256 ?? null;
    const result = await this.cache.ensureReady({ force });
    this.metadata = result.metadata;
    this.parseDiagnostics = result.parseDiagnostics;
    this.index = new HybridIndex(result.chunks);
    const refreshed = beforeHash !== null ? beforeHash !== result.metadata.sha256 : true;

    return {
      refreshed,
      chunkCount: result.chunks.length,
      metadata: result.metadata
    };
  }

  public async searchDocs(query: string, limit = 8, mode: SearchMode = "auto", debug = false, offset = 0): Promise<SearchResult[]> {
    await this.ensureIndex(false);
    const safeLimit = clamp(limit, 1, 25);
    const safeOffset = clamp(offset, 0, 2000);
    return this.index ? this.index.search(query, safeLimit, mode, debug, safeOffset) : [];
  }

  public async readSection(id: string): Promise<DocChunk | null> {
    await this.ensureIndex(false);
    return this.index?.getById(id) ?? null;
  }

  public async readContext(id: string, before = 1, after = 1, mode: ContextMode = "section"): Promise<DocChunk[]> {
    await this.ensureIndex(false);
    const safeBefore = clamp(before, 0, 10);
    const safeAfter = clamp(after, 0, 10);
    return this.index?.getContext(id, safeBefore, safeAfter, mode) ?? [];
  }

  public async readPage(path: string, maxChunks = 12): Promise<DocChunk[]> {
    await this.ensureIndex(false);
    const safeMax = clamp(maxChunks, 1, 30);
    const chunks = this.index?.getPage(path) ?? [];
    return chunks.slice(0, safeMax);
  }

  public async listPages(prefix = "", limit = 50): Promise<PageSummary[]> {
    await this.ensureIndex(false);
    const safeLimit = clamp(limit, 1, 200);
    return this.index?.listPages(prefix, safeLimit) ?? [];
  }

  public async getStatus(): Promise<StatusReport> {
    const hasCache = await cacheExistsOnDisk();
    const metadata = await this.cache.getMetadata();
    const lastValidationError = this.cache.getLastValidationError();

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
      hasCache,
      freshness: {
        state: freshnessState,
        softTtlHours: msToHours(SOFT_TTL_MS),
        hardTtlHours: msToHours(HARD_TTL_MS),
        ageSinceValidationHours: ageHours,
        lastValidationError
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

    const result = await this.cache.ensureReady({ force });
    this.metadata = result.metadata;
    this.parseDiagnostics = result.parseDiagnostics;
    this.index = new HybridIndex(result.chunks);
    logInfo("Index ready", {
      chunkCount: result.chunks.length,
      staleFallback: result.usedStaleCacheDueToError
    });
  }
}

function msToHours(ms: number): number {
  return Math.round((ms / (60 * 60 * 1000)) * 100) / 100;
}
