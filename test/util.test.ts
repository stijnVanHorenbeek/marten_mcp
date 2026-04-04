import { describe, expect, test } from "bun:test";
import { paginateTextWindow, tokenize } from "../src/util.js";

describe("tokenize", () => {
  test("splits identifier-style tokens into useful parts", () => {
    const terms = tokenize("IDocumentSession StoreAsync session.Query<User>()");

    expect(terms).toContain("idocumentsession");
    expect(terms).toContain("document");
    expect(terms).toContain("session");
    expect(terms).toContain("storeasync");
    expect(terms).toContain("store");
    expect(terms).toContain("async");
    expect(terms).toContain("query");
    expect(terms).toContain("user");
  });

  test("normalizes simple plural forms", () => {
    const terms = tokenize("projections events queries");
    expect(terms).toContain("projection");
    expect(terms).toContain("event");
    expect(terms).toContain("query");
  });
});

describe("paginateTextWindow", () => {
  test("returns continuation metadata for long content", () => {
    const text = "x".repeat(1200);
    const first = paginateTextWindow(text, 0, 500);
    const second = paginateTextWindow(text, first.nextOffset ?? 0, 500);

    expect(first.length).toBe(500);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(500);
    expect(second.offset).toBe(500);
    expect(second.length).toBe(500);
    expect(second.totalChars).toBe(1200);
  });
});
