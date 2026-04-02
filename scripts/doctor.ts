import fs from "node:fs/promises";
import path from "node:path";
import { SOURCE_URL, detectRuntime, resolveCachePaths, resolveSqliteDriver, resolveStorageMode } from "../src/config.js";

type Health = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Health;
  detail: string;
}

interface DoctorReport {
  sourceUrl: string;
  storageMode: string;
  runtime: string;
  sqliteDriver: string;
  cache: {
    dir: string;
    docsFile: string;
    metadataFile: string;
    validationHistoryFile: string;
    indexSnapshotFile: string;
    sqliteFile: string;
  };
  checks: Check[];
  summary: {
    status: Health;
    ok: number;
    warn: number;
    fail: number;
  };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const cache = resolveCachePaths();
  const storageMode = resolveStorageMode();
  const runtime = detectRuntime();
  const sqliteDriver = resolveSqliteDriver();

  const checks: Check[] = [];
  checks.push(await checkCacheDirWritable(cache.dir));
  if (storageMode === "sqlite") {
    checks.push(await checkFile(cache.sqliteFile, "sqlite file", true));
  } else {
    checks.push(await checkFile(cache.docsFile, "docs file"));
    checks.push(await checkFile(cache.metadataFile, "metadata file"));
    checks.push(await checkFile(cache.validationHistoryFile, "validation history file", true));
    checks.push(await checkFile(cache.indexSnapshotFile, "index snapshot file", true));
  }
  checks.push(await checkSourceReachable(SOURCE_URL));

  const summary = summarize(checks);
  const report: DoctorReport = {
    sourceUrl: SOURCE_URL,
    storageMode,
    runtime,
    sqliteDriver,
    cache: {
      dir: cache.dir,
      docsFile: cache.docsFile,
      metadataFile: cache.metadataFile,
      validationHistoryFile: cache.validationHistoryFile,
      indexSnapshotFile: cache.indexSnapshotFile,
      sqliteFile: cache.sqliteFile
    },
    checks,
    summary
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderMarkdown(report));
  }

  if (summary.status === "fail") {
    process.exitCode = 1;
  }
}

async function checkCacheDirWritable(cacheDir: string): Promise<Check> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const probe = path.join(cacheDir, `.doctor-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    return {
      name: "cache_dir_writable",
      status: "ok",
      detail: `Writable: ${cacheDir}`
    };
  } catch (error) {
    return {
      name: "cache_dir_writable",
      status: "fail",
      detail: `Cannot write to cache dir ${cacheDir}: ${errorMessage(error)}`
    };
  }
}

async function checkFile(filePath: string, label: string, optional = false): Promise<Check> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return {
        name: label.replace(/\s+/g, "_"),
        status: optional ? "warn" : "fail",
        detail: `${label} path exists but is not a regular file: ${filePath}`
      };
    }

    return {
      name: label.replace(/\s+/g, "_"),
      status: "ok",
      detail: `${label} present (${stat.size} bytes)`
    };
  } catch {
    if (optional) {
      return {
        name: label.replace(/\s+/g, "_"),
        status: "ok",
        detail: `${label} not found yet (normal until first related event): ${filePath}`
      };
    }

    return {
      name: label.replace(/\s+/g, "_"),
      status: "warn",
      detail: `${label} not found: ${filePath}`
    };
  }
}

async function checkSourceReachable(url: string): Promise<Check> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (response.ok || response.status === 304) {
      return {
        name: "source_reachable",
        status: "ok",
        detail: `Reachable (${response.status})`
      };
    }

    return {
      name: "source_reachable",
      status: "warn",
      detail: `Reachability check returned ${response.status}`
    };
  } catch (error) {
    return {
      name: "source_reachable",
      status: "warn",
      detail: `Network check failed: ${errorMessage(error)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(checks: Check[]): DoctorReport["summary"] {
  const ok = checks.filter((check) => check.status === "ok").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const fail = checks.filter((check) => check.status === "fail").length;

  const status: Health = fail > 0 ? "fail" : warn > 0 ? "warn" : "ok";
  return { status, ok, warn, fail };
}

function renderMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`# Marten MCP Doctor`);
  lines.push(``);
  lines.push(`- Source URL: ${report.sourceUrl}`);
  lines.push(`- Runtime: ${report.runtime}`);
  lines.push(`- Storage: ${report.storageMode} (sqliteDriver=${report.sqliteDriver})`);
  lines.push(`- Cache Dir: \`${report.cache.dir}\``);
  lines.push(`- Overall: **${report.summary.status.toUpperCase()}** (ok=${report.summary.ok}, warn=${report.summary.warn}, fail=${report.summary.fail})`);
  lines.push(``);
  lines.push(`## Checks`);

  for (const check of report.checks) {
    lines.push(`- [${check.status.toUpperCase()}] \`${check.name}\` - ${check.detail}`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

void main().catch((error) => {
  process.stderr.write(`[doctor] failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
