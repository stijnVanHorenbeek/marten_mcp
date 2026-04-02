import { describe, expect, test } from "bun:test";
import { tokenize } from "../src/util.js";

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
