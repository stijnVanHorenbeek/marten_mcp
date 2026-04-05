import fs from "node:fs/promises";
import { detectRuntime, resolveCachePaths, resolveRequestedStorageMode, resolveSqliteDriver, resolveStorageMode } from "./config.js";
import { logWarn } from "./logger.js";
import type {
  CacheMetadata,
  CachePaths,
  IndexSnapshotRecord,
  SqliteDriver,
  StorageMode,
  ValidationFailureRecord
} from "./types.js";

export interface CacheStorage {
  ensureReady(): Promise<void>;
  readDocs(): Promise<string | null>;
  writeDocs(raw: string): Promise<void>;
  readMetadata(): Promise<CacheMetadata | null>;
  writeMetadata(meta: CacheMetadata): Promise<void>;
  readValidationHistory(): Promise<ValidationFailureRecord[]>;
  writeValidationHistory(history: ValidationFailureRecord[]): Promise<void>;
  readIndexSnapshot(): Promise<IndexSnapshotRecord | null>;
  writeIndexSnapshot(snapshot: IndexSnapshotRecord): Promise<void>;
  getCachePath(): string;
  getStorageMode(): StorageMode;
}

export async function createDefaultStorage(): Promise<CacheStorage> {
  const mode = resolveStorageMode();
  if (mode === "sqlite") {
    try {
      return await SqliteStorage.create(resolveCachePaths(), resolveSqliteDriver());
    } catch (error) {
      const configuredMode = resolveRequestedStorageMode();
      if (configuredMode === "sqlite") {
        throw error;
      }

      logWarn("SQLite storage unavailable; falling back to JSON storage", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return new JsonStorage(resolveCachePaths());
}

class JsonStorage implements CacheStorage {
  public constructor(private readonly paths: CachePaths) {}

  public async ensureReady(): Promise<void> {
    await fs.mkdir(this.paths.dir, { recursive: true });
  }

  public async readDocs(): Promise<string | null> {
    try {
      return await fs.readFile(this.paths.docsFile, "utf8");
    } catch {
      return null;
    }
  }

  public async writeDocs(raw: string): Promise<void> {
    await fs.writeFile(this.paths.docsFile, raw, "utf8");
  }

  public async readMetadata(): Promise<CacheMetadata | null> {
    try {
      const json = await fs.readFile(this.paths.metadataFile, "utf8");
      return JSON.parse(json) as CacheMetadata;
    } catch {
      return null;
    }
  }

  public async writeMetadata(meta: CacheMetadata): Promise<void> {
    await fs.writeFile(this.paths.metadataFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  public async readValidationHistory(): Promise<ValidationFailureRecord[]> {
    try {
      const json = await fs.readFile(this.paths.validationHistoryFile, "utf8");
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(
        (item): item is ValidationFailureRecord =>
          typeof item === "object" &&
          item !== null &&
          "at" in item &&
          "message" in item &&
          typeof (item as { at: unknown }).at === "string" &&
          typeof (item as { message: unknown }).message === "string"
      );
    } catch {
      return [];
    }
  }

  public async writeValidationHistory(history: ValidationFailureRecord[]): Promise<void> {
    await fs.writeFile(this.paths.validationHistoryFile, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  }

  public async readIndexSnapshot(): Promise<IndexSnapshotRecord | null> {
    try {
      const json = await fs.readFile(this.paths.indexSnapshotFile, "utf8");
      const parsed = JSON.parse(json) as IndexSnapshotRecord;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      if (!Array.isArray(parsed.chunks) || !parsed.parseDiagnostics) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  public async writeIndexSnapshot(snapshot: IndexSnapshotRecord): Promise<void> {
    await fs.writeFile(this.paths.indexSnapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  public getCachePath(): string {
    return this.paths.dir;
  }

  public getStorageMode(): StorageMode {
    return "json";
  }
}

class SqliteStorage implements CacheStorage {
  private constructor(
    private readonly paths: CachePaths,
    private readonly db: SqliteDbLike
  ) {}

  public static async create(paths: CachePaths, requestedDriver: SqliteDriver): Promise<SqliteStorage> {
    await fs.mkdir(paths.dir, { recursive: true });
    const db = await openSqlite(paths.sqliteFile, requestedDriver);
    const storage = new SqliteStorage(paths, db);
    await storage.ensureReady();
    return storage;
  }

  public async ensureReady(): Promise<void> {
    this.db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  public async readDocs(): Promise<string | null> {
    return this.readValue("docs");
  }

  public async writeDocs(raw: string): Promise<void> {
    this.writeValue("docs", raw);
  }

  public async readMetadata(): Promise<CacheMetadata | null> {
    const value = await this.readValue("metadata");
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value) as CacheMetadata;
    } catch {
      return null;
    }
  }

  public async writeMetadata(meta: CacheMetadata): Promise<void> {
    this.writeValue("metadata", JSON.stringify(meta));
  }

  public async readValidationHistory(): Promise<ValidationFailureRecord[]> {
    const value = await this.readValue("validation_history");
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(
        (item): item is ValidationFailureRecord =>
          typeof item === "object" &&
          item !== null &&
          "at" in item &&
          "message" in item &&
          typeof (item as { at: unknown }).at === "string" &&
          typeof (item as { message: unknown }).message === "string"
      );
    } catch {
      return [];
    }
  }

  public async writeValidationHistory(history: ValidationFailureRecord[]): Promise<void> {
    this.writeValue("validation_history", JSON.stringify(history));
  }

  public async readIndexSnapshot(): Promise<IndexSnapshotRecord | null> {
    const value = await this.readValue("index_snapshot");
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as IndexSnapshotRecord;
      if (!parsed || !Array.isArray(parsed.chunks) || !parsed.parseDiagnostics) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  public async writeIndexSnapshot(snapshot: IndexSnapshotRecord): Promise<void> {
    this.writeValue("index_snapshot", JSON.stringify(snapshot));
  }

  public getCachePath(): string {
    return this.paths.sqliteFile;
  }

  public getStorageMode(): StorageMode {
    return "sqlite";
  }

  private async readValue(key: string): Promise<string | null> {
    const row = this.db.get<{ value?: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    return typeof row?.value === "string" ? row.value : null;
  }

  private writeValue(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [key, value]);
  }
}

interface SqliteDbLike {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get<T>(sql: string, params?: unknown[]): T | undefined;
}

async function openSqlite(filePath: string, requestedDriver: SqliteDriver): Promise<SqliteDbLike> {
  const runtime = detectRuntime();
  const driver =
    requestedDriver === "auto"
      ? runtime === "bun"
        ? "bun-sqlite"
        : "node-sqlite"
      : requestedDriver;

  if (driver === "bun-sqlite") {
    const moduleName = "bun:sqlite";
    const mod = (await import(moduleName)) as { Database: new (file: string, options?: { create?: boolean }) => BunDbLike };
    const db = new mod.Database(filePath, { create: true });
    return {
      exec(sql: string): void {
        db.exec(sql);
      },
      run(sql: string, params: unknown[] = []): void {
        db.prepare(sql).run(...params);
      },
      get<T>(sql: string, params: unknown[] = []): T | undefined {
        return db.prepare(sql).get(...params) as T | undefined;
      }
    };
  }

  const moduleName = "node:sqlite";
  const mod = (await import(moduleName)) as { DatabaseSync: new (file: string) => NodeSqliteLike };
  const db = new mod.DatabaseSync(filePath);
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, params: unknown[] = []): void {
      db.prepare(sql).run(...params);
    },
    get<T>(sql: string, params: unknown[] = []): T | undefined {
      return db.prepare(sql).get(...params) as T | undefined;
    }
  };
}

interface BunDbLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}

interface NodeSqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}
