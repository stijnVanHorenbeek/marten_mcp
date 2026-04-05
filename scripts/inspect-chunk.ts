import { DocsService } from "../src/service.js";
import type { DocChunk } from "../src/types.js";

interface InspectChunkOptions {
  id: string;
  context: number;
  bodyOnly: boolean;
  codeOnly: boolean;
  rawOnly: boolean;
}

interface ChunkReaderApi {
  initialize(): Promise<void>;
  readSection(id: string): Promise<DocChunk | null>;
  readContext(id: string, before?: number, after?: number, mode?: "section"): Promise<DocChunk[]>;
}

export async function inspectChunk(options: InspectChunkOptions, service: ChunkReaderApi = new DocsService()): Promise<string> {
  await service.initialize();
  const chunk = await service.readSection(options.id);
  if (!chunk) {
    throw new Error(`Chunk not found: ${options.id}`);
  }

  const lines: string[] = [];
  lines.push(`Chunk: ${chunk.id}`);
  lines.push(`Path: ${chunk.path}`);
  lines.push(`Title: ${chunk.title}`);
  lines.push(`Headings: ${chunk.headings.length > 0 ? chunk.headings.join(" > ") : "(none)"}`);
  lines.push(`PageOrder: ${chunk.pageOrder}`);
  lines.push(`Lengths: body=${chunk.body_text.length} code=${chunk.code_text.length} raw=${chunk.raw_text.length}`);

  const showAll = !options.bodyOnly && !options.codeOnly && !options.rawOnly;
  if (showAll || options.bodyOnly) {
    lines.push("");
    lines.push("== body_text ==");
    lines.push(chunk.body_text.length > 0 ? chunk.body_text : "(empty)");
  }
  if (showAll || options.codeOnly) {
    lines.push("");
    lines.push("== code_text ==");
    lines.push(chunk.code_text.length > 0 ? chunk.code_text : "(empty)");
  }
  if (showAll || options.rawOnly) {
    lines.push("");
    lines.push("== raw_text ==");
    lines.push(chunk.raw_text.length > 0 ? chunk.raw_text : "(empty)");
  }

  if (options.context > 0) {
    const context = await service.readContext(chunk.id, options.context, options.context, "section");
    lines.push("");
    lines.push(`== context (+/-${options.context}) ==`);
    for (const ref of context) {
      lines.push(
        `- ${ref.id} pageOrder=${ref.pageOrder} headings=${ref.headings.length > 0 ? ref.headings.join(" > ") : "(none)"} lengths: body=${ref.body_text.length} code=${ref.code_text.length} raw=${ref.raw_text.length}`
      );
    }
  }

  return lines.join("\n");
}

function parseArgs(args: string[]): InspectChunkOptions {
  const id = readOption(args, "--id") ?? "";
  if (!id) {
    throw new Error("Missing required --id <chunk-id>");
  }

  const contextRaw = readOption(args, "--context");
  const context = contextRaw ? Math.max(0, Number.parseInt(contextRaw, 10) || 0) : 0;
  const bodyOnly = args.includes("--body-only");
  const codeOnly = args.includes("--code-only");
  const rawOnly = args.includes("--raw-only") || args.includes("--raw");

  return {
    id,
    context,
    bodyOnly,
    codeOnly,
    rawOnly
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
  const output = await inspectChunk(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${output}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[inspect-chunk] failed: ${message}\n`);
    process.exitCode = 1;
  });
}
