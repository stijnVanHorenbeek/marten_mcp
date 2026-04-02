import { describe, expect, test } from "bun:test";
import { parsePagesWithDiagnostics } from "../src/parser.js";

describe("page parser hardening", () => {
  test("uses strict mode for canonical markers", () => {
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
});
