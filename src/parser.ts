import type { DocChunk, PageDoc, ParseDiagnostics } from "./types.js";

const SOFT_CHUNK_CHARS = 2200;
const HARD_CHUNK_CHARS = 3200;
const MAX_PARSE_WARNINGS = 8;

interface ParsePagesResult {
  pages: PageDoc[];
  diagnostics: ParseDiagnostics;
}

interface PageMarker {
  path: string;
  markerStartLine: number;
  contentStartLine: number;
}

type Block =
  | { type: "heading"; level: number; text: string; raw: string }
  | { type: "paragraph"; text: string; raw: string }
  | { type: "code"; language: string | null; code: string; raw: string }
  | { type: "admonition"; kind: string | null; text: string; raw: string }
  | { type: "image"; alt: string; target: string | null; raw: string }
  | { type: "boilerplate"; kind: "snippet-anchor"; raw: string };

interface HeadingStackEntry {
  level: number;
  text: string;
}

interface SectionBlocks {
  headings: string[];
  blocks: Block[];
}

export function parsePages(raw: string): PageDoc[] {
  return parsePagesWithDiagnostics(raw).pages;
}

export function parsePagesWithDiagnostics(raw: string): ParsePagesResult {
  const strict = parseByLineMarkers(raw);
  const loose = parseByLooseMarkers(raw);

  if (strict.pages.length > 0 && loose.diagnostics.pageMarkerCount <= strict.diagnostics.pageMarkerCount) {
    return strict;
  }

  if (loose.pages.length > 0) {
    return {
      pages: loose.pages,
      diagnostics: {
        mode: "fallback",
        pageMarkerCount: loose.diagnostics.pageMarkerCount,
        malformedMarkerCount: loose.diagnostics.malformedMarkerCount,
        warnings: [...strict.diagnostics.warnings, ...loose.diagnostics.warnings].slice(0, MAX_PARSE_WARNINGS)
      }
    };
  }

  const fallback = parseByFrontmatterScan(raw);
  if (fallback.pages.length > 0) {
    const warnings = [...strict.diagnostics.warnings, ...loose.diagnostics.warnings, ...fallback.diagnostics.warnings].slice(
      0,
      MAX_PARSE_WARNINGS
    );
    return {
      pages: fallback.pages,
      diagnostics: {
        mode: "fallback",
        pageMarkerCount: fallback.diagnostics.pageMarkerCount,
        malformedMarkerCount: fallback.diagnostics.malformedMarkerCount,
        warnings
      }
    };
  }

  return {
    pages: [
      {
        path: "/unknown",
        title: extractTitleFromLines(raw.split(/\r?\n/)) ?? "Marten Docs",
        raw
      }
    ],
    diagnostics: {
      mode: "single-page-fallback",
      pageMarkerCount: 0,
      malformedMarkerCount: fallback.diagnostics.malformedMarkerCount,
      warnings: [...strict.diagnostics.warnings, ...loose.diagnostics.warnings, ...fallback.diagnostics.warnings, "No valid page markers found; using single-page fallback."].slice(0, MAX_PARSE_WARNINGS)
    }
  };
}

export function chunkPages(pages: PageDoc[]): DocChunk[] {
  const chunks: DocChunk[] = [];
  let order = 0;

  for (const page of pages) {
    const blocks = parseBlocks(page.raw.split(/\r?\n/));
    const sections = splitSections(blocks);
    let pageOrder = 0;

    for (const section of sections) {
      const blockGroups = chunkSectionBlocks(section.blocks);
      for (const blockGroup of blockGroups) {
        const fields = buildChunkFields(blockGroup);
        if (!fields.raw_text && !fields.body_text && !fields.code_text) {
          continue;
        }

        const id = `${page.path}::${pageOrder}`;

        chunks.push({
          id,
          path: page.path,
          title: page.title,
          headings: section.headings,
          body_text: fields.body_text,
          code_text: fields.code_text,
          raw_text: fields.raw_text,
          order,
          pageOrder
        });

        pageOrder += 1;
        order += 1;
      }
    }
  }

  return chunks;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isSnippetAnchor(line)) {
      blocks.push({ type: "boilerplate", kind: "snippet-anchor", raw: line });
      i += 1;
      continue;
    }

    const fenceOpen = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fenceOpen) {
      const language = fenceOpen[1] ?? null;
      const codeLines: string[] = [];
      const rawLines = [line];
      i += 1;

      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        rawLines.push(lines[i]);
        i += 1;
      }

      if (i < lines.length) {
        rawLines.push(lines[i]);
        i += 1;
      }

      blocks.push({
        type: "code",
        language,
        code: trimBlankEdges(codeLines).join("\n"),
        raw: rawLines.join("\n")
      });
      continue;
    }

    const admonitionOpen = isAdmonitionOpen(line);
    if (admonitionOpen) {
      const kind = admonitionOpen[1]?.toLowerCase() ?? null;
      const bodyLines: string[] = [];
      const rawLines = [line];
      i += 1;

      while (i < lines.length && !isAdmonitionClose(lines[i])) {
        bodyLines.push(lines[i]);
        rawLines.push(lines[i]);
        i += 1;
      }

      if (i < lines.length) {
        rawLines.push(lines[i]);
        i += 1;
      }

      const bodyText = normalizeInlineMarkdown(trimBlankEdges(bodyLines).join("\n"));
      const label = kind ? `${capitalize(kind)}: ` : "";
      blocks.push({
        type: "admonition",
        kind,
        text: `${label}${bodyText}`.trim(),
        raw: rawLines.join("\n")
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: normalizeInlineMarkdown(heading[2]),
        raw: line
      });
      i += 1;
      continue;
    }

    const image = line.match(/!\[(.*?)\]\((.*?)(?:\s+".*?")?\)/);
    if (image) {
      blocks.push({
        type: "image",
        alt: normalizeInlineMarkdown(image[1] ?? ""),
        target: (image[2] ?? "").trim() || null,
        raw: line
      });
      i += 1;
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const paragraphLines = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        break;
      }
      if (isSnippetAnchor(next) || /^```([A-Za-z0-9_-]+)?\s*$/.test(next) || isAdmonitionOpen(next) || /^(#{1,6})\s+/.test(next)) {
        break;
      }
      paragraphLines.push(next);
      i += 1;
    }

    const rawParagraph = trimBlankEdges(paragraphLines).join("\n");
    const text = normalizeInlineMarkdown(rawParagraph);
    if (text) {
      blocks.push({
        type: "paragraph",
        text,
        raw: rawParagraph
      });
    }
  }

  return blocks;
}

function fallbackTitle(path: string): string {
  const clean = path.replace(/^\//, "").replace(/\.md$/i, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || "Marten Docs";
}

function parseByLineMarkers(raw: string): ParsePagesResult {
  const lines = raw.split(/\r?\n/);
  const pages: PageDoc[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const markerPattern = /^---\s+url:\s+(.+?)\s+---\s*$/;

  let currentPath: string | null = null;
  let currentLines: string[] = [];
  let markerCount = 0;

  for (const line of lines) {
    const marker = line.match(markerPattern);
    if (!marker) {
      if (currentPath) {
        currentLines.push(line);
      }
      continue;
    }

    markerCount += 1;
    if (currentPath) {
      const pageLines = trimBlankEdges(currentLines);
      const pageRaw = pageLines.join("\n");
      pages.push({
        path: currentPath,
        title: extractTitleFromLines(pageLines) ?? fallbackTitle(currentPath),
        raw: pageRaw
      });
    }

    currentPath = uniquePath(normalizePath(marker[1]), seenPaths, warnings);
    currentLines = [];
  }

  if (currentPath) {
    const pageLines = trimBlankEdges(currentLines);
    const pageRaw = pageLines.join("\n");
    pages.push({
      path: currentPath,
      title: extractTitleFromLines(pageLines) ?? fallbackTitle(currentPath),
      raw: pageRaw
    });
  }

  if (pages.length === 0) {
    return {
      pages: [],
      diagnostics: {
        mode: "strict",
        pageMarkerCount: 0,
        malformedMarkerCount: 0,
        warnings: ["Line marker parse found no matches."]
      }
    };
  }

  return {
    pages,
    diagnostics: {
      mode: "strict",
      pageMarkerCount: markerCount,
      malformedMarkerCount: 0,
      warnings: warnings.slice(0, MAX_PARSE_WARNINGS)
    }
  };
}

function parseByLooseMarkers(raw: string): ParsePagesResult {
  const markerPattern = /---+\s*url:\s*(.+?)\s*---+/g;
  const matches = Array.from(raw.matchAll(markerPattern));
  if (matches.length === 0) {
    return {
      pages: [],
      diagnostics: {
        mode: "fallback",
        pageMarkerCount: 0,
        malformedMarkerCount: 0,
        warnings: ["Loose marker parse found no matches."]
      }
    };
  }

  const pages: PageDoc[] = [];
  const warnings: string[] = ["Used fallback marker scan for non-canonical page boundaries."];
  const seenPaths = new Set<string>();

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const rawPath = (current[1] ?? "").trim();
    if (!rawPath) {
      continue;
    }

    const path = uniquePath(normalizePath(rawPath), seenPaths, warnings);
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? raw.length;
    const pageRaw = raw.slice(start, end).trim();
    const pageLines = pageRaw.split(/\r?\n/);

    pages.push({
      path,
      title: extractTitleFromLines(pageLines) ?? fallbackTitle(path),
      raw: pageRaw
    });
  }

  return {
    pages,
    diagnostics: {
      mode: "fallback",
      pageMarkerCount: matches.length,
      malformedMarkerCount: 0,
      warnings: warnings.slice(0, MAX_PARSE_WARNINGS)
    }
  };
}

function parseByFrontmatterScan(raw: string): ParsePagesResult {
  const lines = raw.split(/\r?\n/);
  const markers: PageMarker[] = [];
  const warnings: string[] = [];
  let malformedMarkerCount = 0;
  const seenPaths = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "---") {
      continue;
    }

    const closeIndex = findFrontmatterClose(lines, i + 1);
    if (closeIndex < 0) {
      malformedMarkerCount += 1;
      warnings.push(`Ignored frontmatter block at line ${i + 1}: missing closing marker.`);
      continue;
    }

    const frontmatterLines = lines.slice(i + 1, closeIndex);
    const props = parseFrontmatter(frontmatterLines);
    const rawPath = props.url ?? props.path;
    if (!rawPath || !rawPath.trim()) {
      malformedMarkerCount += 1;
      warnings.push(`Ignored frontmatter block at line ${i + 1}: missing url/path.`);
      i = closeIndex;
      continue;
    }

    const path = uniquePath(normalizePath(rawPath), seenPaths, warnings);
    markers.push({
      path,
      markerStartLine: i,
      contentStartLine: closeIndex + 1
    });
    i = closeIndex;
  }

  if (markers.length === 0) {
    return {
      pages: [],
      diagnostics: {
        mode: "fallback",
        pageMarkerCount: 0,
        malformedMarkerCount,
        warnings: warnings.slice(0, MAX_PARSE_WARNINGS)
      }
    };
  }

  const pages: PageDoc[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const next = markers[i + 1];
    const endLine = next ? Math.max(marker.contentStartLine, next.markerStartLine) : lines.length;
    const pageRaw = lines.slice(marker.contentStartLine, endLine).join("\n").trim();
    pages.push({
      path: marker.path,
      title: extractTitleFromLines(pageRaw.split(/\r?\n/)) ?? fallbackTitle(marker.path),
      raw: pageRaw
    });
  }

  return {
    pages,
    diagnostics: {
      mode: "fallback",
      pageMarkerCount: markers.length,
      malformedMarkerCount,
      warnings: warnings.slice(0, MAX_PARSE_WARNINGS)
    }
  };
}

function findFrontmatterClose(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return i;
    }
  }
  return -1;
}

function parseFrontmatter(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    out[match[1].toLowerCase()] = match[2].trim();
  }
  return out;
}

function splitSections(blocks: Block[]): SectionBlocks[] {
  const sections: SectionBlocks[] = [];
  const headingStack: HeadingStackEntry[] = [];
  let currentBlocks: Block[] = [];

  for (const block of blocks) {
    if (block.type === "heading") {
      if (currentBlocks.length > 0) {
        sections.push({ headings: headingPathFromStack(headingStack), blocks: currentBlocks });
      }

      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= block.level) {
        headingStack.pop();
      }
      headingStack.push({ level: block.level, text: block.text });
      currentBlocks = [block];
      continue;
    }

    currentBlocks.push(block);
  }

  if (currentBlocks.length > 0) {
    sections.push({ headings: headingPathFromStack(headingStack), blocks: currentBlocks });
  }

  return sections;
}

function headingPathFromStack(stack: HeadingStackEntry[]): string[] {
  return stack.map((entry) => entry.text);
}

function chunkSectionBlocks(sectionBlocks: Block[]): Block[][] {
  const chunks: Block[][] = [];
  let current: Block[] = [];
  let size = 0;

  for (const block of sectionBlocks) {
    const blockSize = estimateBlockSize(block);
    if (current.length > 0 && size + blockSize > SOFT_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    if (blockSize > HARD_CHUNK_CHARS) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        size = 0;
      }

      chunks.push(...splitOversizedBlock(block));
      continue;
    }

    current.push(block);
    size += blockSize;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function splitOversizedBlock(block: Block): Block[][] {
  if (block.type === "code") {
    return splitLargeCodeBlock(block).map((part) => [part]);
  }

  if (block.type === "paragraph" || block.type === "admonition") {
    return splitLargeTextBlock(block).map((part) => [part]);
  }

  if (block.type === "heading") {
    return [[block]];
  }

  return splitRawBlock(block).map((part) => [part]);
}

function splitLargeCodeBlock(block: Extract<Block, { type: "code" }>): Extract<Block, { type: "code" }>[] {
  const lines = block.code.split(/\r?\n/);
  if (lines.length === 0) {
    return [block];
  }

  const out: Extract<Block, { type: "code" }>[] = [];
  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    const lineSize = line.length + 1;
    if (current.length > 0 && size + lineSize > HARD_CHUNK_CHARS) {
      out.push(makeCodeBlock(block.language, current));
      current = [];
      size = 0;
    }

    if (line.length > HARD_CHUNK_CHARS) {
      if (current.length > 0) {
        out.push(makeCodeBlock(block.language, current));
        current = [];
        size = 0;
      }

      let start = 0;
      while (start < line.length) {
        const part = line.slice(start, start + HARD_CHUNK_CHARS);
        out.push(makeCodeBlock(block.language, [part]));
        start += HARD_CHUNK_CHARS;
      }
      continue;
    }

    current.push(line);
    size += lineSize;
  }

  if (current.length > 0) {
    out.push(makeCodeBlock(block.language, current));
  }

  return out.length > 0 ? out : [block];
}

function splitLargeTextBlock<T extends Extract<Block, { type: "paragraph" | "admonition" }>>(block: T): T[] {
  const sentences = splitSentences(block.text);
  if (sentences.length <= 1) {
    return splitTextBySize(block);
  }

  const out: T[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= HARD_CHUNK_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      out.push(cloneTextBlock(block, current));
      current = "";
    }

    if (sentence.length <= HARD_CHUNK_CHARS) {
      current = sentence;
    } else {
      const chunks = sentence.match(new RegExp(`.{1,${HARD_CHUNK_CHARS}}`, "g")) ?? [sentence];
      for (const part of chunks) {
        out.push(cloneTextBlock(block, part));
      }
    }
  }

  if (current) {
    out.push(cloneTextBlock(block, current));
  }

  return out.length > 0 ? out : [block];
}

function splitTextBySize<T extends Extract<Block, { type: "paragraph" | "admonition" }>>(block: T): T[] {
  const parts = block.text.match(new RegExp(`.{1,${HARD_CHUNK_CHARS}}`, "g")) ?? [block.text];
  return parts.map((part) => cloneTextBlock(block, part));
}

function splitRawBlock(block: Exclude<Block, { type: "heading" | "paragraph" | "admonition" | "code" }>): Block[] {
  const raw = block.raw;
  if (raw.length <= HARD_CHUNK_CHARS) {
    return [block];
  }

  const parts = raw.match(new RegExp(`.{1,${HARD_CHUNK_CHARS}}`, "g")) ?? [raw];
  return parts.map((part) => ({ ...block, raw: part }));
}

function buildChunkFields(blocks: Block[]): Pick<DocChunk, "headings" | "body_text" | "code_text" | "raw_text"> {
  const headings = blocks.filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading").map((b) => b.text);
  const body_text = blocks
    .filter((b): b is Extract<Block, { type: "paragraph" | "admonition" | "image" }> =>
      b.type === "paragraph" || b.type === "admonition" || b.type === "image"
    )
    .map((b) => {
      if (b.type === "image") {
        return b.alt ? `Image: ${b.alt}` : b.target ? `Image: ${b.target}` : "Image";
      }
      return b.text;
    })
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();

  const code_text = blocks
    .filter((b): b is Extract<Block, { type: "code" }> => b.type === "code")
    .map((b) => b.code)
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();

  const raw_text = blocks
    .filter((b) => b.type !== "boilerplate")
    .map((b) => b.raw)
    .filter((text) => text.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    headings,
    body_text,
    code_text,
    raw_text
  };
}

function estimateBlockSize(block: Block): number {
  switch (block.type) {
    case "heading":
      return block.raw.length;
    case "paragraph":
      return block.text.length;
    case "admonition":
      return block.text.length;
    case "code":
      return block.code.length;
    case "image":
      return (block.alt.length || 0) + (block.target?.length || 0);
    case "boilerplate":
      return 0;
  }
}

function makeCodeBlock(language: string | null, lines: string[]): Extract<Block, { type: "code" }> {
  const code = lines.join("\n");
  const fenceLabel = language ?? "";
  return {
    type: "code",
    language,
    code,
    raw: [`\`\`\`${fenceLabel}`, ...lines, "```"].join("\n")
  };
}

function cloneTextBlock<T extends Extract<Block, { type: "paragraph" | "admonition" }>>(block: T, text: string): T {
  if (block.type === "paragraph") {
    return {
      ...block,
      text,
      raw: text
    } as T;
  }

  return {
    ...block,
    text,
    raw: text
  } as T;
}

function splitSentences(input: string): string[] {
  return input
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isSnippetAnchor(line: string): boolean {
  return /^\s*snippet source \| anchor\s*$/.test(line);
}

function isAdmonitionOpen(line: string): RegExpMatchArray | null {
  return line.match(/^\s*:::\s*(tip|info|warning|danger|details)\s*$/i);
}

function isAdmonitionClose(line: string): boolean {
  return /^\s*:::\s*$/.test(line);
}

function extractTitleFromLines(lines: string[]): string | null {
  let inFence = false;
  for (const line of lines) {
    if (/^```([A-Za-z0-9_-]+)?\s*$/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const heading = line.match(/^#\s+(.+?)\s*$/);
    if (heading) {
      return normalizeInlineMarkdown(heading[1]);
    }
  }

  return null;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start]!.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]!.trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function normalizeInlineMarkdown(input: string): string {
  const withoutImages = input.replace(/!\[(.*?)\]\((.*?)(?:\s+".*?")?\)/g, "$1");
  const withoutLinks = withoutImages.replace(/\[(.*?)\]\((.*?)\)/g, "$1");
  const withoutCodeTicks = withoutLinks.replace(/`([^`]+)`/g, "$1");
  const withoutEmphasis = withoutCodeTicks.replace(/[*_~]/g, "");
  return withoutEmphasis.replace(/\s+/g, " ").trim();
}

function capitalize(input: string): string {
  if (!input) {
    return input;
  }
  return `${input[0]!.toUpperCase()}${input.slice(1).toLowerCase()}`;
}

function normalizePath(value: string): string {
  let path = value.trim().replace(/^['"]|['"]$/g, "");
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  return path;
}

function uniquePath(path: string, seen: Set<string>, warnings: string[]): string {
  if (!seen.has(path)) {
    seen.add(path);
    return path;
  }

  let suffix = 2;
  while (seen.has(`${path}#${suffix}`)) {
    suffix += 1;
  }
  const unique = `${path}#${suffix}`;
  seen.add(unique);
  warnings.push(`Duplicate page path '${path}' was renamed to '${unique}'.`);
  return unique;
}
