import type { DocChunk, PageDoc, ParseDiagnostics } from "./types.js";

const MAX_CHUNK_CHARS = 1800;
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

export function parsePages(raw: string): PageDoc[] {
  return parsePagesWithDiagnostics(raw).pages;
}

export function parsePagesWithDiagnostics(raw: string): ParsePagesResult {
  const strict = parseByStrictMarkers(raw);
  if (strict.pages.length > 0) {
    return strict;
  }

  const fallback = parseByFrontmatterScan(raw);
  if (fallback.pages.length > 0) {
    const warnings = [...strict.diagnostics.warnings, ...fallback.diagnostics.warnings].slice(0, MAX_PARSE_WARNINGS);
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
        title: extractTitle(raw) ?? "Marten Docs",
        raw
      }
    ],
    diagnostics: {
      mode: "single-page-fallback",
      pageMarkerCount: 0,
      malformedMarkerCount: fallback.diagnostics.malformedMarkerCount,
      warnings: [...strict.diagnostics.warnings, ...fallback.diagnostics.warnings, "No valid page markers found; using single-page fallback."].slice(
        0,
        MAX_PARSE_WARNINGS
      )
    }
  };
}

export function chunkPages(pages: PageDoc[]): DocChunk[] {
  const chunks: DocChunk[] = [];
  let order = 0;

  for (const page of pages) {
    const sections = splitByHeading(page.raw);
    let pageOrder = 0;

    for (const section of sections) {
      const pieces = splitLargeSection(section.content, MAX_CHUNK_CHARS);
      for (const piece of pieces) {
        const id = `${page.path}::${pageOrder}`;
        const codeText = extractCodeBlocks(piece).join("\n\n");
        const bodyText = stripCodeBlocks(piece);

        chunks.push({
          id,
          path: page.path,
          title: page.title,
          headings: section.headings,
          body_text: bodyText,
          code_text: codeText,
          raw_text: piece,
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

interface SectionBlock {
  headings: string[];
  content: string;
}

function splitByHeading(raw: string): SectionBlock[] {
  const lines = raw.split(/\r?\n/);
  const sections: SectionBlock[] = [];

  let currentContent: string[] = [];
  let headingStack: string[] = [];

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      if (currentContent.join("\n").trim().length > 0) {
        sections.push({
          headings: [...headingStack],
          content: currentContent.join("\n").trim()
        });
      }

      headingStack = headingStack.slice(0, heading.level - 1);
      headingStack[heading.level - 1] = heading.text;
      currentContent = [line];
      continue;
    }

    currentContent.push(line);
  }

  if (currentContent.join("\n").trim().length > 0) {
    sections.push({
      headings: [...headingStack],
      content: currentContent.join("\n").trim()
    });
  }

  if (sections.length === 0) {
    sections.push({ headings: [], content: raw.trim() });
  }

  return sections;
}

function splitLargeSection(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) {
    return [content.trim()];
  }

  const blocks = content.split(/\n\n+/);
  const out: string[] = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      out.push(current.trim());
      current = "";
    }

    if (block.length <= maxChars) {
      current = block;
      continue;
    }

    for (let i = 0; i < block.length; i += maxChars) {
      out.push(block.slice(i, i + maxChars).trim());
    }
  }

  if (current.trim()) {
    out.push(current.trim());
  }

  return out.filter((x) => x.length > 0);
}

function extractCodeBlocks(content: string): string[] {
  const blocks = content.match(/```[\s\S]*?```/g);
  return blocks ?? [];
}

function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, " ").trim();
}

function parseHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2].trim()
  };
}

function extractTitle(input: string): string | null {
  const match = /^#\s+(.+)$/m.exec(input);
  return match ? match[1].trim() : null;
}

function fallbackTitle(path: string): string {
  const clean = path.replace(/^\//, "").replace(/\.md$/i, "");
  const parts = clean.split("/");
  return parts[parts.length - 1] || "Marten Docs";
}

function parseByStrictMarkers(raw: string): ParsePagesResult {
  const markerRegex = /^---\s*\nurl:\s*(.+?)\s*\n---\s*$/gm;
  const matches = Array.from(raw.matchAll(markerRegex));
  if (matches.length === 0) {
    return {
      pages: [],
      diagnostics: {
        mode: "strict",
        pageMarkerCount: 0,
        malformedMarkerCount: 0,
        warnings: ["Strict marker parse found no matches."]
      }
    };
  }

  const pages: PageDoc[] = [];
  const seenPaths = new Set<string>();
  const warnings: string[] = [];

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const rawPath = current[1].trim();
    const path = uniquePath(normalizePath(rawPath), seenPaths, warnings);
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? raw.length;
    const pageRaw = raw.slice(start, end).trim();
    pages.push({
      path,
      title: extractTitle(pageRaw) ?? fallbackTitle(path),
      raw: pageRaw
    });
  }

  return {
    pages,
    diagnostics: {
      mode: "strict",
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
      title: extractTitle(pageRaw) ?? fallbackTitle(marker.path),
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
