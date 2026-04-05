import { DocsService } from "../src/service.js";
import type { QueryProfileInspection } from "../src/indexer.js";
import type { DocChunk, SearchResult } from "../src/types.js";

interface InspectQueryOptions {
  query: string;
  limit: number;
  path?: string;
  showProfile: boolean;
  showPageChunks: boolean;
}

interface QueryInspectorApi {
  initialize(): Promise<void>;
  searchDocs(query: string, limit?: number, mode?: "auto", debug?: boolean, offset?: number): Promise<SearchResult[]>;
  searchWithinPage(
    path: string,
    query: string,
    limit?: number,
    mode?: "auto",
    debug?: boolean,
    offset?: number
  ): Promise<SearchResult[]>;
  getPage(path: string): Promise<DocChunk[]>;
  inspectQueryProfile(query: string): QueryProfileInspection;
}

export async function inspectQuery(options: InspectQueryOptions, service: QueryInspectorApi = new DocsService()): Promise<string> {
  await service.initialize();
  const results = options.path
    ? await service.searchWithinPage(options.path, options.query, options.limit, "auto")
    : await service.searchDocs(options.query, options.limit, "auto");

  const lines: string[] = [];
  lines.push(`Query: ${options.query}`);
  lines.push(`Limit: ${options.limit}`);
  if (options.path) {
    lines.push(`Path scope: ${options.path}`);
  }
  lines.push(`Results: ${results.length}`);

  results.forEach((row, index) => {
    lines.push("");
    lines.push(`${index + 1}) [${row.score.toFixed(3)}] ${row.id}`);
    lines.push(`   path: ${row.path}`);
    lines.push(`   title: ${row.title}`);
    lines.push(`   headings: ${row.headings.length > 0 ? row.headings.join(" > ") : "(none)"}`);
    lines.push(`   snippet: ${row.snippet}`);
  });

  if (options.showProfile) {
    const profile = service.inspectQueryProfile(options.query);
    lines.push("");
    lines.push("== query profile ==");
    lines.push(`queryClass: ${profile.queryClass}`);
    lines.push(`shortQuery: ${profile.shortQuery}`);
    lines.push(`symbolHeavy: ${profile.symbolHeavy}`);
    lines.push(`lexicalTerms: ${profile.lexicalTerms.length > 0 ? profile.lexicalTerms.join(", ") : "(none)"}`);
    lines.push(`identifierTerms: ${profile.identifierTerms.length > 0 ? profile.identifierTerms.join(", ") : "(none)"}`);
    lines.push(`suppressedTerms: ${profile.suppressedTerms.length > 0 ? profile.suppressedTerms.join(", ") : "(none)"}`);
  }

  if (options.showPageChunks && options.path) {
    const page = await service.getPage(options.path);
    lines.push("");
    lines.push(`== page chunks (${options.path}) ==`);
    for (const chunk of page) {
      lines.push(
        `- ${chunk.id} pageOrder=${chunk.pageOrder} headings=${chunk.headings.length > 0 ? chunk.headings.join(" > ") : "(none)"} lengths: body=${chunk.body_text.length} code=${chunk.code_text.length} raw=${chunk.raw_text.length}`
      );
    }
  }

  return lines.join("\n");
}

function parseArgs(args: string[]): InspectQueryOptions {
  const query = readOption(args, "--query") ?? "";
  if (!query) {
    throw new Error("Missing required --query \"...\"");
  }

  const limitRaw = readOption(args, "--limit");
  const limit = Math.max(1, Math.min(25, limitRaw ? Number.parseInt(limitRaw, 10) || 5 : 5));
  const path = readOption(args, "--path") ?? undefined;

  return {
    query,
    limit,
    path,
    showProfile: args.includes("--show-profile"),
    showPageChunks: args.includes("--show-page-chunks")
  };
}

function readOption(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx < 0) {
    return null;
  }

  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    return null;
  }

  return value;
}

async function main(): Promise<void> {
  const output = await inspectQuery(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${output}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[inspect-query] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
