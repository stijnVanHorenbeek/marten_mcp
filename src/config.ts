import path from "node:path";
import os from "node:os";
import type { CachePaths } from "./types.js";

export const SOURCE_URL = "https://martendb.io/llms-full.txt";
export const SOFT_TTL_MS = 12 * 60 * 60 * 1000;
export const HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PARSER_VERSION = "v1";
export const INDEX_VERSION = "v1";

export function resolveCachePaths(): CachePaths {
  const baseDir = process.env.MARTEN_MCP_CACHE_DIR
    ? path.resolve(process.env.MARTEN_MCP_CACHE_DIR)
    : path.join(os.homedir(), ".cache", "marten-docs-mcp");

  return {
    dir: baseDir,
    docsFile: path.join(baseDir, "llms-full.txt"),
    metadataFile: path.join(baseDir, "metadata.json")
  };
}
