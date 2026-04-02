import path from "node:path";
import os from "node:os";
import type { CachePaths, SearchFieldWeights, SqliteDriver, StorageMode } from "./types.js";

export const SOURCE_URL = "https://martendb.io/llms-full.txt";
export const SOFT_TTL_MS = 12 * 60 * 60 * 1000;
export const HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PARSER_VERSION = "v1";
export const INDEX_VERSION = "v1";
export const SEARCH_FIELD_WEIGHTS: SearchFieldWeights = {
  title: parseEnvWeight("MARTEN_MCP_WEIGHT_TITLE", 0.4),
  headings: parseEnvWeight("MARTEN_MCP_WEIGHT_HEADINGS", 0.3),
  path: parseEnvWeight("MARTEN_MCP_WEIGHT_PATH", 0.25),
  body: parseEnvWeight("MARTEN_MCP_WEIGHT_BODY", 0.15),
  code: parseEnvWeight("MARTEN_MCP_WEIGHT_CODE", 0.35)
};

export function resolveCachePaths(): CachePaths {
  const baseDir = process.env.MARTEN_MCP_CACHE_DIR
    ? path.resolve(process.env.MARTEN_MCP_CACHE_DIR)
    : path.join(os.homedir(), ".cache", "marten-docs-mcp");

  return {
    dir: baseDir,
    docsFile: path.join(baseDir, "llms-full.txt"),
    metadataFile: path.join(baseDir, "metadata.json"),
    validationHistoryFile: path.join(baseDir, "validation-history.json"),
    indexSnapshotFile: path.join(baseDir, "index-snapshot.json"),
    sqliteFile: process.env.MARTEN_MCP_SQLITE_PATH ?? path.join(baseDir, "cache.db")
  };
}

export function resolveStorageMode(): StorageMode {
  const mode = (process.env.MARTEN_MCP_STORAGE_MODE ?? "auto").trim().toLowerCase();
  if (mode === "json" || mode === "sqlite") {
    return mode;
  }

  return detectRuntime() === "bun" ? "sqlite" : "json";
}

export function resolveSqliteDriver(): SqliteDriver {
  const driver = (process.env.MARTEN_MCP_SQLITE_DRIVER ?? "auto").trim().toLowerCase();
  if (driver === "bun-sqlite" || driver === "node-sqlite" || driver === "auto") {
    return driver;
  }

  return "auto";
}

export function detectRuntime(): "bun" | "node" | "unknown" {
  const bunGlobal = (globalThis as Record<string, unknown>).Bun;
  if (bunGlobal && typeof bunGlobal === "object") {
    return "bun";
  }

  if (process.release?.name === "node") {
    return "node";
  }

  return "unknown";
}

function parseEnvWeight(envName: string, fallback: number): number {
  const value = process.env[envName];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
