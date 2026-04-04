import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { mineTelemetry, type CliOptions } from "../scripts/mine-eval-from-telemetry.ts";
import { TelemetrySink } from "../src/telemetry.js";

describe("telemetry and eval mining", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("writes telemetry jsonl records", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-mcp-telemetry-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "events.jsonl");

    const sink = new TelemetrySink(filePath);
    sink.record({
      tool: "search_docs",
      queryTerms: ["compiled", "queries"],
      mode: "auto",
      limit: 8,
      offset: 0,
      debug: false,
      count: 1,
      topResultPaths: ["/documents/querying/compiled-queries.md"]
    });
    sink.record({
      tool: "read_section",
      id: "chunk-1",
      field: "raw_text",
      found: true,
      path: "/documents/querying/compiled-queries.md"
    });

    await sink.flush();

    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split(/\r?\n/);
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]) as { event?: { tool?: string; queryTerms?: string[] } };
    const second = JSON.parse(lines[1]) as { event?: { tool?: string; path?: string } };
    expect(first.event?.tool).toBe("search_docs");
    expect(first.event?.queryTerms).toEqual(["compiled", "queries"]);
    expect(second.event?.tool).toBe("read_section");
    expect(second.event?.path).toBe("/documents/querying/compiled-queries.md");
  });

  test("mines candidate expectations from telemetry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-mcp-mine-"));
    tempDirs.push(tempDir);

    const inputPath = path.join(tempDir, "telemetry.jsonl");
    const outputPath = path.join(tempDir, "mined.json");
    const lines = [
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 42,
          seq: 1,
          ts: "2026-04-03T00:00:00.000Z",
          queryTerms: ["compiled", "queries"],
          topResultPaths: ["/documents/querying/compiled-queries.md"]
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "read_section",
          processId: 42,
          seq: 2,
          ts: "2026-04-03T00:00:05.000Z",
          path: "/documents/querying/compiled-queries.md"
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 42,
          seq: 3,
          ts: "2026-04-03T00:00:10.000Z",
          queryTerms: ["compiled", "queries"],
          topResultPaths: ["/documents/querying/compiled-queries.md"]
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_within_page",
          processId: 42,
          seq: 4,
          ts: "2026-04-03T00:00:12.000Z",
          path: "/documents/querying/compiled-queries.md",
          queryTerms: ["compiled", "queries"],
          topChunkIds: ["c2"]
        }
      }
    ].map((row) => JSON.stringify(row));
    await fs.writeFile(inputPath, `${lines.join("\n")}\n`, "utf8");

    const options: CliOptions = {
      input: inputPath,
      output: outputPath,
      minSearches: 2,
      minSelections: 1,
      windowMs: 120000,
      minShare: 0.25,
      clusterSimilarity: 0.6,
      clusterMinSharedTerms: 2
    };

    const result = await mineTelemetry(options);
    expect(result.parsedEvents).toBe(4);
    expect(result.minedCandidates).toBe(1);

    const output = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
      candidates: Array<{ query: string; suggestedExpected: { pathIncludes?: string } }>;
    };
    expect(output.candidates.length).toBe(1);
    expect(output.candidates[0]?.query).toBe("compiled queries");
    expect(output.candidates[0]?.suggestedExpected.pathIncludes).toBe("/documents/querying/compiled-queries.md");
  });

  test("attributes read to search containing selected path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-mcp-mine-attribution-"));
    tempDirs.push(tempDir);

    const inputPath = path.join(tempDir, "telemetry.jsonl");
    const outputPath = path.join(tempDir, "mined.json");
    const lines = [
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 42,
          seq: 1,
          ts: "2026-04-03T00:00:00.000Z",
          queryTerms: ["first", "query"],
          topResultPaths: ["/a.md"]
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 42,
          seq: 2,
          ts: "2026-04-03T00:00:01.000Z",
          queryTerms: ["second", "query"],
          topResultPaths: ["/b.md"]
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "read_section",
          processId: 42,
          seq: 3,
          ts: "2026-04-03T00:00:02.000Z",
          path: "/a.md"
        }
      }
    ].map((row) => JSON.stringify(row));
    await fs.writeFile(inputPath, `${lines.join("\n")}\n`, "utf8");

    const options: CliOptions = {
      input: inputPath,
      output: outputPath,
      minSearches: 1,
      minSelections: 1,
      windowMs: 120000,
      minShare: 0.25,
      clusterSimilarity: 0.6,
      clusterMinSharedTerms: 2
    };

    const result = await mineTelemetry(options);
    expect(result.minedCandidates).toBe(1);

    const output = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
      candidates: Array<{ query: string; selections: number }>;
    };

    expect(output.candidates[0]?.query).toBe("first query");
    expect(output.candidates[0]?.selections).toBe(1);
  });

  test("clusters similar queries before thresholding", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marten-mcp-mine-cluster-"));
    tempDirs.push(tempDir);

    const inputPath = path.join(tempDir, "telemetry.jsonl");
    const outputPath = path.join(tempDir, "mined.json");

    const lines = [
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 9,
          seq: 1,
          ts: "2026-04-03T00:00:00.000Z",
          queryTerms: ["marten", "multi", "stream", "projection", "identity", "deleteevent", "shoulddelete"],
          topResultPaths: ["/events/projections/conventions.md"]
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "read_section",
          processId: 9,
          seq: 2,
          ts: "2026-04-03T00:00:01.000Z",
          path: "/events/projections/conventions.md"
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_docs",
          processId: 9,
          seq: 3,
          ts: "2026-04-03T00:00:02.000Z",
          queryTerms: ["marten", "multi", "stream", "projection", "deleteevent", "aggregate", "deletion"],
          topResultPaths: ["/events/projections/multi-stream-projections.md"]
        }
      },
      {
        schema: "marten-mcp-telemetry",
        version: 1,
        event: {
          tool: "search_within_page",
          processId: 9,
          seq: 4,
          ts: "2026-04-03T00:00:03.000Z",
          path: "/events/projections/multi-stream-projections.md",
          queryTerms: ["deleteevent"],
          topChunkIds: ["b"]
        }
      }
    ].map((row) => JSON.stringify(row));

    await fs.writeFile(inputPath, `${lines.join("\n")}\n`, "utf8");

    const options: CliOptions = {
      input: inputPath,
      output: outputPath,
      minSearches: 2,
      minSelections: 2,
      windowMs: 120000,
      minShare: 0.25,
      clusterSimilarity: 0.1,
      clusterMinSharedTerms: 2
    };

    const result = await mineTelemetry(options);
    expect(result.minedCandidates).toBe(1);

    const output = JSON.parse(await fs.readFile(outputPath, "utf8")) as {
      candidates: Array<{
        searches: number;
        selections: number;
        queryVariants?: Array<{ query: string; count: number }>;
      }>;
    };

    expect(output.candidates.length).toBe(1);
    expect(output.candidates[0]?.searches).toBe(2);
    expect(output.candidates[0]?.selections).toBe(2);
    expect(output.candidates[0]?.queryVariants?.length).toBeGreaterThan(1);
  });
});
