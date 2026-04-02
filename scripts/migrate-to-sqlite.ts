import fs from "node:fs/promises";
import { detectRuntime, resolveCachePaths, resolveSqliteDriver } from "../src/config.js";

interface MigrationPayload {
  docs: string;
  metadata: string;
  validationHistory: string;
  indexSnapshot: string;
}

async function main(): Promise<void> {
  const runtime = detectRuntime();
  const requestedDriver = resolveSqliteDriver();
  const driver = requestedDriver === "auto" ? (runtime === "bun" ? "bun-sqlite" : "node-sqlite") : requestedDriver;
  const paths = resolveCachePaths();

  const payload = await readJsonCachePayload(paths);
  const db = await openSqlite(paths.sqliteFile, driver);
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", ["docs", payload.docs]);
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", ["metadata", payload.metadata]);
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", ["validation_history", payload.validationHistory]);
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", ["index_snapshot", payload.indexSnapshot]);

  process.stdout.write("SQLite migration complete\n");
  process.stdout.write(`- Driver: ${driver}\n`);
  process.stdout.write(`- Source docs: ${paths.docsFile}\n`);
  process.stdout.write(`- Source metadata: ${paths.metadataFile}\n`);
  process.stdout.write(`- Destination db: ${paths.sqliteFile}\n`);
}

async function readJsonCachePayload(paths: ReturnType<typeof resolveCachePaths>): Promise<MigrationPayload> {
  const docs = await readRequiredFile(paths.docsFile, "docs file");
  const metadata = await readRequiredFile(paths.metadataFile, "metadata file");
  const validationHistory = await readOptionalJsonArray(paths.validationHistoryFile, "[]");
  const indexSnapshot = await readOptionalJsonObject(paths.indexSnapshotFile, "null");

  return {
    docs,
    metadata,
    validationHistory,
    indexSnapshot
  };
}

async function readRequiredFile(filePath: string, label: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${errorMessage(error)}`);
  }
}

async function readOptionalJsonArray(filePath: string, fallback: string): Promise<string> {
  try {
    const value = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return JSON.stringify(parsed);
  } catch {
    return fallback;
  }
}

async function readOptionalJsonObject(filePath: string, fallback: string): Promise<string> {
  try {
    const value = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return fallback;
    }
    return JSON.stringify(parsed);
  } catch {
    return fallback;
  }
}

interface SqliteDbLike {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
}

async function openSqlite(filePath: string, driver: "bun-sqlite" | "node-sqlite"): Promise<SqliteDbLike> {
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
    }
  };
}

interface BunDbLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
}

interface NodeSqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

void main().catch((error) => {
  process.stderr.write(`[migrate:sqlite] failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
