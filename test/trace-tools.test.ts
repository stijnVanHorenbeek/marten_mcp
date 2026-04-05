import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { toTelemetryPreview } from "../src/telemetry.js";
import { analyzeTrace } from "../scripts/trace-analyze.ts";
import { parseTelemetryLines, selectTrace, type TelemetryEnvelope } from "../scripts/lib/telemetry-events.ts";
import { resolveTelemetryInputFile, resolveTelemetryInputPath } from "../scripts/lib/telemetry-paths.ts";
import { renderTrace } from "../scripts/trace-show.ts";

describe("trace tooling", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
    delete process.env.MARTEN_MCP_TELEMETRY_PATH;
  });

  test("parses old and new telemetry shapes", () => {
    const lines = [
      JSON.stringify({
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 12,
          seq: 1,
          ts: "2026-04-05T00:00:00.000Z",
          queryTerms: ["compiled", "queries"],
          topResultPaths: ["/docs/a.md"]
        }
      }),
      JSON.stringify({
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "read_section",
          processId: 12,
          seq: 2,
          ts: "2026-04-05T00:00:01.000Z",
          id: "chunk-1",
          path: "/docs/a.md",
          requestedSegmentIndex: null,
          resolvedSegmentIndex: 0,
          segmentKind: "prose",
          found: true,
          offset: 0,
          maxChars: 800,
          returnedChars: 180,
          hasMore: false,
          preview: "compiled query preview",
          query: "compiled queries",
          topResults: [{ id: "chunk-1", path: "/docs/a.md", title: "A", score: 0.91 }]
        }
      })
    ];

    const parsed = parseTelemetryLines(lines);
    expect(parsed.length).toBe(2);
    expect(parsed[0]?.event.tool).toBe("search_docs");
    expect(parsed[1]?.event.tool).toBe("read_section");
  });

  test("selects latest process trace", () => {
    const envelopes: TelemetryEnvelope[] = [
      makeSearchEvent(1, 1, "2026-04-05T00:00:00.000Z", "/a.md"),
      makeSearchEvent(2, 1, "2026-04-05T00:00:02.000Z", "/b.md")
    ];

    const selected = selectTrace(envelopes, { latest: true });
    expect(selected.length).toBe(1);
    expect(selected[0]?.event.processId).toBe(2);
  });

  test("normalizes and truncates preview", () => {
    const preview = toTelemetryPreview("first\n\nsecond\tthird", 12);
    expect(preview).toBe("first secon…");
  });

  test("analysis flags repeated similar searches", () => {
    const trace: TelemetryEnvelope[] = [
      makeSearchEvent(44, 1, "2026-04-05T00:00:00.000Z", "/docs/a.md", ["query", "one", "again"]),
      makeSearchEvent(44, 2, "2026-04-05T00:00:01.000Z", "/docs/b.md", ["query", "one", "again"]),
      makeSearchEvent(44, 3, "2026-04-05T00:00:02.000Z", "/docs/c.md", ["query", "one", "again"])
    ];

    const analysis = analyzeTrace(trace);
    expect(analysis.flags).toContain("repeated_similar_searches");
    expect(analysis.flags).toContain("repeated_global_search_drift");
  });

  test("trace rendering includes top hits and previews", () => {
    const trace: TelemetryEnvelope[] = [
      makeSearchEvent(99, 1, "2026-04-05T00:00:00.000Z", "/docs/a.md", ["loadmanyasync"]),
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "read_section",
          processId: 99,
          seq: 2,
          ts: "2026-04-05T00:00:02.000Z",
          id: "chunk-7",
          requestedSegmentIndex: null,
          resolvedSegmentIndex: 1,
          segmentKind: "code",
          found: true,
          path: "/docs/a.md",
          offset: 0,
          maxChars: 800,
          returnedChars: 120,
          hasMore: false,
          preview: "await session.LoadManyAsync<User>(...)",
          neighborChunkIds: ["chunk-6", "chunk-8"]
        }
      }
    ];

    const output = renderTrace(trace);
    expect(output).toContain("search_docs");
    expect(output).toContain("top hits:");
    expect(output).toContain("read_section");
    expect(output).toContain("segmentKind=code");
    expect(output).toContain("neighbors: chunk-6, chunk-8");
    expect(output).toContain("LoadManyAsync");
  });

  test("resolves latest file from directory input", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-trace-latest-"));
    tempDirs.push(tempDir);
    const older = path.join(tempDir, "2026-04-04.jsonl");
    const newer = path.join(tempDir, "2026-04-05.jsonl");
    await fs.writeFile(older, "\n", "utf8");
    await fs.writeFile(newer, "\n", "utf8");
    await fs.utimes(older, new Date("2026-04-04T00:00:00.000Z"), new Date("2026-04-04T00:00:00.000Z"));
    await fs.utimes(newer, new Date("2026-04-05T00:00:00.000Z"), new Date("2026-04-05T00:00:00.000Z"));

    const resolved = await resolveTelemetryInputFile({ explicitInput: tempDir, latest: true });
    expect(resolved.filePath).toBe(newer);
  });

  test("uses file input directly", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-trace-file-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "events.jsonl");
    await fs.writeFile(filePath, "\n", "utf8");

    const resolved = await resolveTelemetryInputFile({ explicitInput: filePath, latest: true });
    expect(resolved.filePath).toBe(filePath);
  });

  test("uses env var when explicit input is absent", () => {
    process.env.MARTEN_MCP_TELEMETRY_PATH = "/tmp/env-telemetry.jsonl";
    const resolved = resolveTelemetryInputPath();
    expect(resolved).toBe(path.resolve("/tmp/env-telemetry.jsonl"));
  });

  test("throws clear error when telemetry path is missing", async () => {
    const missing = path.join(os.tmpdir(), "marten-trace-missing", "none.jsonl");
    await expect(resolveTelemetryInputFile({ explicitInput: missing, latest: true })).rejects.toThrow(
      "Telemetry input not found"
    );
  });

  test("throws clear error for directory input without latest", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-trace-dir-"));
    tempDirs.push(tempDir);
    await fs.writeFile(path.join(tempDir, "2026-04-05.jsonl"), "\n", "utf8");

    await expect(resolveTelemetryInputFile({ explicitInput: tempDir, latest: false })).rejects.toThrow(
      "Pass --latest"
    );
  });
});

function makeSearchEvent(
  processId: number,
  seq: number,
  ts: string,
  topPath: string,
  queryTerms: string[] = ["compiled", "queries"]
): TelemetryEnvelope {
  return {
    schema: "marten-mcp-telemetry",
    version: 1,
    event: {
      tool: "search_docs",
      processId,
      seq,
      ts,
      queryTerms,
      query: queryTerms.join(" "),
      mode: "auto",
      limit: 3,
      offset: 0,
      debug: false,
      count: 3,
      topResultPaths: [topPath],
      topResults: [{ id: `chunk-${seq}`, path: topPath, title: "Title", score: 0.81 }]
    }
  };
}
