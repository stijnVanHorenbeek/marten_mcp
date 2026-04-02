import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolveCachePaths } from "../src/config.js";
import { DocsService } from "../src/service.js";

interface PerfReport {
  startupMs: number;
  index: {
    chunkCount: number;
    pageCount: number;
    snapshotBytes: number | null;
  };
  search: {
    samples: number;
    avgMs: number;
    p95Ms: number;
  };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const service = new DocsService();

  const start = performance.now();
  await service.initialize();
  const startupMs = round(performance.now() - start);

  const status = await service.getStatus();
  const snapshotBytes = await readSnapshotBytes();

  const queries = [
    "aggregate projections",
    "session.Query<User>()",
    "async daemon",
    "multi tenancy",
    "compiled queries"
  ];

  const sampleDurations: number[] = [];
  for (let i = 0; i < 20; i++) {
    const query = queries[i % queries.length] ?? "aggregate projections";
    const qStart = performance.now();
    await service.searchDocs(query, 8, "auto");
    sampleDurations.push(performance.now() - qStart);
  }

  const report: PerfReport = {
    startupMs,
    index: {
      chunkCount: status.index.chunkCount,
      pageCount: status.index.pageCount,
      snapshotBytes
    },
    search: {
      samples: sampleDurations.length,
      avgMs: round(avg(sampleDurations)),
      p95Ms: round(p95(sampleDurations))
    }
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderMarkdown(report));
  }
}

async function readSnapshotBytes(): Promise<number | null> {
  const paths = resolveCachePaths();
  try {
    const stat = await fs.stat(paths.indexSnapshotFile);
    return stat.size;
  } catch {
    return null;
  }
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderMarkdown(report: PerfReport): string {
  return [
    "# Marten MCP Perf Smoke",
    "",
    `- Startup: ${report.startupMs} ms`,
    `- Index: chunks=${report.index.chunkCount}, pages=${report.index.pageCount}, snapshotBytes=${report.index.snapshotBytes ?? "n/a"}`,
    `- Search: samples=${report.search.samples}, avg=${report.search.avgMs} ms, p95=${report.search.p95Ms} ms`,
    ""
  ].join("\n");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[perf-smoke] failed: ${message}\n`);
  process.exitCode = 1;
});
