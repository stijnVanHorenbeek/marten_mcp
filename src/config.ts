import path from "node:path";
import os from "node:os";
import type { CachePaths, SearchFieldWeights, SqliteDriver, StorageMode } from "./types.js";

const DEFAULT_SOURCE_URL = "https://martendb.io/llms-full.txt";
const DEFAULT_SOFT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SOURCE_URL = readEnvString("MARTEN_MCP_SOURCE_URL") ?? DEFAULT_SOURCE_URL;
export const SOFT_TTL_MS = readEnvInt("MARTEN_MCP_SOFT_TTL_MS", DEFAULT_SOFT_TTL_MS, 60_000, 30 * 24 * 60 * 60 * 1000);
export const HARD_TTL_MS = readEnvInt(
  "MARTEN_MCP_HARD_TTL_MS",
  DEFAULT_HARD_TTL_MS,
  SOFT_TTL_MS,
  365 * 24 * 60 * 60 * 1000
);
export const PARSER_VERSION = "v2";
export const INDEX_VERSION = "v1";

export interface McpRuntimeConfig {
  maxSearchLimit: number;
  maxWithinPageLimit: number;
  maxReadChars: number;
}

export const MCP_RUNTIME_CONFIG: McpRuntimeConfig = {
  maxSearchLimit: readEnvInt("MARTEN_MCP_MAX_SEARCH_LIMIT", 5, 1, 25),
  maxWithinPageLimit: readEnvInt("MARTEN_MCP_MAX_WITHIN_PAGE_LIMIT", 4, 1, 20),
  maxReadChars: readEnvInt("MARTEN_MCP_MAX_READ_CHARS", 3000, 200, 8000)
};

export const SEARCH_FIELD_WEIGHTS: SearchFieldWeights = resolveSearchFieldWeights();

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
  const mode = resolveRequestedStorageMode();
  if (mode === "json" || mode === "sqlite") {
    return mode;
  }

  return detectRuntime() === "bun" ? "sqlite" : "json";
}

export function resolveSqliteDriver(): SqliteDriver {
  const driver = (readEnvString("MARTEN_MCP_SQLITE_DRIVER") ?? "auto").toLowerCase();
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
  const parsed = readEnvNumber(envName);
  if (parsed === null || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function resolveSearchFieldWeights(): SearchFieldWeights {
  return {
    title: parseEnvWeight("MARTEN_MCP_WEIGHT_TITLE", 0.4),
    headings: parseEnvWeight("MARTEN_MCP_WEIGHT_HEADINGS", 0.3),
    path: parseEnvWeight("MARTEN_MCP_WEIGHT_PATH", 0.25),
    body: parseEnvWeight("MARTEN_MCP_WEIGHT_BODY", 0.15),
    code: parseEnvWeight("MARTEN_MCP_WEIGHT_CODE", 0.35)
  };
}

export function resolveRequestedStorageMode(): "auto" | StorageMode {
  const mode = (readEnvString("MARTEN_MCP_STORAGE_MODE") ?? "auto").toLowerCase();
  if (mode === "auto" || mode === "json" || mode === "sqlite") {
    return mode;
  }

  return "auto";
}

function readEnvString(envName: string): string | null {
  const raw = process.env[envName]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function readEnvNumber(envName: string): number | null {
  const raw = readEnvString(envName);
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function readEnvInt(envName: string, fallback: number, min: number, max: number): number {
  const parsed = readEnvNumber(envName);
  if (parsed === null) {
    return fallback;
  }

  const rounded = Math.round(parsed);
  return Math.max(min, Math.min(max, rounded));
}
