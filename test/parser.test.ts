import { describe, expect, test } from "bun:test";
import { chunkPages, parsePagesWithDiagnostics } from "../src/parser.js";

describe("page parser hardening", () => {
  test("uses strict mode for line markers", () => {
    const raw = `--- url: /alpha.md ---
# Alpha

alpha

--- url: /beta.md ---
# Beta

beta`;

    const result = parsePagesWithDiagnostics(raw);
    expect(result.diagnostics.mode).toBe("strict");
    expect(result.pages.length).toBe(2);
    expect(result.diagnostics.malformedMarkerCount).toBe(0);
    expect(result.pages[0]?.path).toBe("/alpha.md");
    expect(result.pages[1]?.path).toBe("/beta.md");
  });

  test("uses strict mode for canonical multi-line url markers", () => {
    const raw = `---
url: /alpha.md
---
# Alpha

alpha

---
url: /beta.md
---
# Beta

beta`;

    const result = parsePagesWithDiagnostics(raw);
    expect(result.diagnostics.mode).toBe("strict");
    expect(result.pages.length).toBe(2);
    expect(result.diagnostics.malformedMarkerCount).toBe(0);
    expect(result.pages[0]?.path).toBe("/alpha.md");
    expect(result.pages[1]?.path).toBe("/beta.md");
  });

  test("falls back for frontmatter with extra fields and path key", () => {
    const raw = `---
title: Alpha Page
path: alpha.md
section: events
---
# Alpha

alpha body

---
url: /beta.md
author: docs
---
# Beta

beta body`;

    const result = parsePagesWithDiagnostics(raw);
    expect(result.diagnostics.mode).toBe("fallback");
    expect(result.pages.length).toBe(2);
    expect(result.diagnostics.malformedMarkerCount).toBe(0);
    expect(result.pages[0]?.path).toBe("/alpha.md");
    expect(result.pages[1]?.path).toBe("/beta.md");
  });

  test("uses fallback parser when marker appears adjacent to content", () => {
    const raw = `--- url: /alpha.md ---
# Alpha
alpha tail--- url: /beta.md ---
# Beta
beta body`;

    const result = parsePagesWithDiagnostics(raw);
    expect(result.diagnostics.mode).toBe("fallback");
    expect(result.diagnostics.pageMarkerCount).toBe(2);
    expect(result.diagnostics.warnings.some((w) => w.includes("fallback marker scan"))).toBe(true);
    expect(result.pages.length).toBe(2);
    expect(result.pages[0]?.path).toBe("/alpha.md");
    expect(result.pages[1]?.path).toBe("/beta.md");
  });

  test("ignores malformed frontmatter blocks without url/path", () => {
    const raw = `---
title: not a marker
---
noise

---
path: /gamma.md
---
# Gamma

gamma body`;

    const result = parsePagesWithDiagnostics(raw);
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]?.path).toBe("/gamma.md");
    expect(result.diagnostics.malformedMarkerCount).toBe(1);
    expect(result.diagnostics.warnings.some((w) => w.includes("missing url/path"))).toBe(true);
  });

  test("uses single-page fallback when no markers exist", () => {
    const raw = `# Standalone\n\nNo marker format.`;
    const result = parsePagesWithDiagnostics(raw);
    expect(result.diagnostics.mode).toBe("single-page-fallback");
    expect(result.diagnostics.malformedMarkerCount).toBe(0);
    expect(result.pages.length).toBe(1);
    expect(result.pages[0]?.path).toBe("/unknown");
  });

  test("heading detection is fence-aware", () => {
    const raw = `--- url: /code.md ---
# Guide

\`\`\`cs
# not-a-heading
var x = 1;
\`\`\`

## Real Heading

Text under heading.`;

    const pages = parsePagesWithDiagnostics(raw).pages;
    const chunks = chunkPages(pages);

    expect(chunks.some((chunk) => chunk.headings.includes("not-a-heading"))).toBe(false);
    expect(chunks.some((chunk) => chunk.headings.includes("Real Heading"))).toBe(true);
  });

  test("strips snippet source anchor boilerplate from indexed fields", () => {
    const raw = `--- url: /boilerplate.md ---
# Boilerplate

snippet source | anchor

Actual content.`;

    const pages = parsePagesWithDiagnostics(raw).pages;
    const chunks = chunkPages(pages);
    const joinedBody = chunks.map((chunk) => chunk.body_text).join("\n");
    const joinedRaw = chunks.map((chunk) => chunk.raw_text).join("\n");

    expect(joinedBody.includes("snippet source | anchor")).toBe(false);
    expect(joinedRaw.includes("snippet source | anchor")).toBe(false);
    expect(joinedBody.includes("Actual content")).toBe(true);
  });

  test("parses admonitions and removes ::: wrappers from body text", () => {
    const raw = `--- url: /admonitions.md ---
# Admonitions

::: tip
Use this approach.
:::

::: warning
Danger zone.
:::`;

    const pages = parsePagesWithDiagnostics(raw).pages;
    const chunks = chunkPages(pages);
    const body = chunks.map((chunk) => chunk.body_text).join("\n");

    expect(body.includes("Tip: Use this approach.")).toBe(true);
    expect(body.includes("Warning: Danger zone.")).toBe(true);
    expect(body.includes(":::")).toBe(false);
  });

  test("extracts code_text without fenced markdown wrappers", () => {
    const raw = `--- url: /code-text.md ---
# Code Text

\`\`\`ts
const value = 42;
\`\`\`

Paragraph.`;

    const pages = parsePagesWithDiagnostics(raw).pages;
    const chunks = chunkPages(pages);
    const code = chunks.map((chunk) => chunk.code_text).join("\n");

    expect(code.includes("const value = 42;")).toBe(true);
    expect(code.includes("```")).toBe(false);
  });

  test("chunks large sections by block boundaries", () => {
    const longParagraph = "Alpha sentence. ".repeat(280);
    const raw = `--- url: /chunking.md ---
# Chunking

${longParagraph}

${longParagraph}`;

    const pages = parsePagesWithDiagnostics(raw).pages;
    const chunks = chunkPages(pages);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.raw_text.length <= 3200)).toBe(true);
  });

  test("preserves full heading ancestry on deep sections", () => {
    const raw = `--- url: /headings.md ---
# Root

Intro.

## Child

Child text.

### Grandchild

Leaf text.`;

    const pages = parsePagesWithDiagnostics(raw).pages;
    const chunks = chunkPages(pages);
    const leafChunk = chunks.find((chunk) => chunk.body_text.includes("Leaf text"));

    expect(leafChunk).toBeTruthy();
    expect(leafChunk?.headings).toEqual(["Root", "Child", "Grandchild"]);
  });
});
