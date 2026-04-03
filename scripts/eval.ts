import fs from "node:fs/promises";
import path from "node:path";
import { DocsService } from "../src/service.js";

interface BaselineCase {
  query: string;
  expected: {
    pathIncludes?: string;
    pathAnyOf?: string[];
    headingIncludes?: string;
  };
}

interface EvalResultRow {
  query: string;
  passTop1: boolean;
  passTop3: boolean;
  expectedPath: string;
  actualTop1Path: string | null;
}

const TOP3_TARGET = 0.85;

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const record = args.has("--record");

  const queryFile = path.join(process.cwd(), "eval", "queries.json");
  const baselineFile = path.join(process.cwd(), "eval", "baseline.json");

  const queries = await readQueries(queryFile);
  const service = new DocsService();
  await service.initialize();

  if (record) {
    const rows: BaselineCase[] = [];
    for (const query of queries) {
      const results = await service.searchDocs(query, 3, "auto");
      const first = results[0];
      if (!first) {
        continue;
      }

      rows.push({
        query,
        expected: {
          pathIncludes: first.path,
          headingIncludes: first.headings[0]
        }
      });
    }

    await fs.writeFile(baselineFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    process.stdout.write(`Recorded ${rows.length} baseline expectations to eval/baseline.json\n`);
    return;
  }

  const baseline = await readBaseline(baselineFile);
  const byQuery = new Map<string, BaselineCase>(baseline.map((row) => [row.query, row]));
  const rows: EvalResultRow[] = [];

  for (const query of queries) {
    const expected = byQuery.get(query);
    if (!expected) {
      rows.push({
        query,
        passTop1: false,
        passTop3: false,
        expectedPath: "<missing baseline>",
        actualTop1Path: null
      });
      continue;
    }

    const results = await service.searchDocs(query, 3, "auto");
    const top1 = results[0];
    const top3 = results.slice(0, 3);

    const passTop1 = top1 ? isMatch(top1.path, top1.headings, expected.expected) : false;
    const passTop3 = top3.some((result) => isMatch(result.path, result.headings, expected.expected));

    rows.push({
      query,
      passTop1,
      passTop3,
      expectedPath: describeExpectedPaths(expected.expected),
      actualTop1Path: top1?.path ?? null
    });
  }

  const top1Hits = rows.filter((row) => row.passTop1).length;
  const top3Hits = rows.filter((row) => row.passTop3).length;
  const top1Rate = rows.length > 0 ? top1Hits / rows.length : 0;
  const top3Rate = rows.length > 0 ? top3Hits / rows.length : 0;

  process.stdout.write(`Eval queries: ${rows.length}\n`);
  process.stdout.write(`Top-1 hit rate: ${(top1Rate * 100).toFixed(1)}% (${top1Hits}/${rows.length})\n`);
  process.stdout.write(`Top-3 hit rate: ${(top3Rate * 100).toFixed(1)}% (${top3Hits}/${rows.length})\n`);
  process.stdout.write(`Target top-3 hit rate: ${(TOP3_TARGET * 100).toFixed(1)}%\n`);

  const failures = rows.filter((row) => !row.passTop3);
  if (failures.length > 0) {
    process.stdout.write("\nTop-3 misses:\n");
    for (const row of failures) {
      process.stdout.write(
        `- ${row.query}\n  expected path contains: ${row.expectedPath}\n  actual top-1 path: ${row.actualTop1Path ?? "<none>"}\n`
      );
    }
  }

  if (top3Rate < TOP3_TARGET) {
    process.exitCode = 1;
  }
}

async function readQueries(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("eval/queries.json must be a JSON array of strings");
  }
  return parsed;
}

async function readBaseline(filePath: string): Promise<BaselineCase[]> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("eval/baseline.json must be an array");
  }
  return parsed as BaselineCase[];
}

function isMatch(pathValue: string, headings: string[], expected: BaselineCase["expected"]): boolean {
  const pathMatch = isPathMatch(pathValue, expected);
  if (!pathMatch) {
    return false;
  }

  if (!expected.headingIncludes) {
    return true;
  }

  return headings.some((heading) => heading.toLowerCase().includes(expected.headingIncludes!.toLowerCase()));
}

function isPathMatch(pathValue: string, expected: BaselineCase["expected"]): boolean {
  const lowerPath = pathValue.toLowerCase();
  const pathAnyOf = expected.pathAnyOf ?? [];
  if (pathAnyOf.length > 0) {
    return pathAnyOf.some((candidate) => lowerPath.includes(candidate.toLowerCase()));
  }

  if (expected.pathIncludes) {
    return lowerPath.includes(expected.pathIncludes.toLowerCase());
  }

  return false;
}

function describeExpectedPaths(expected: BaselineCase["expected"]): string {
  const pathAnyOf = expected.pathAnyOf ?? [];
  if (pathAnyOf.length > 0) {
    return pathAnyOf.join(" | ");
  }

  return expected.pathIncludes ?? "<missing expected path>";
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[eval] failed: ${message}\n`);
  process.exitCode = 1;
});
