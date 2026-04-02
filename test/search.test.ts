import { describe, expect, test } from "bun:test";
import { chunkPages } from "../src/parser.js";
import { HybridIndex } from "../src/indexer.js";

describe("hybrid search", () => {
  test("finds code-like query with trigram behavior", () => {
    const chunks = chunkPages([
      {
        path: "/documents/querying.md",
        title: "Querying",
        raw: `# Querying\n\nUse session.Query<User>() in examples.\n\n\`\`\`cs\nvar users = session.Query<User>();\n\`\`\``
      },
      {
        path: "/events/projections.md",
        title: "Projections",
        raw: `# Projections\n\nA prose-only section about projection lifecycle.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("session.Query<User>()", 5, "auto");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("/documents/querying.md");
  });

  test("finds prose query with lexical behavior", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nAggregate projections combine events into a document snapshot.`
      },
      {
        path: "/storage/schema.md",
        title: "Schema",
        raw: `# Schema\n\nDatabase schema management details.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("aggregate projections", 5, "auto");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("/events/aggregate-projections.md");
  });

  test("read context stays within same heading section when possible", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections

## Lifecycle

Lifecycle text one.

Lifecycle text two.

## Configuration

Configuration text.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const lifecycleChunk = chunks.find((chunk) => chunk.headings.includes("Lifecycle"));
    expect(lifecycleChunk).toBeTruthy();

    const context = index.getContext(lifecycleChunk!.id, 3, 3);
    expect(context.length).toBeGreaterThan(0);
    expect(context.every((chunk) => chunk.headings.includes("Lifecycle"))).toBe(true);
  });

  test("exact phrase boosts title and heading matches", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nCore guide for event aggregation.`
      },
      {
        path: "/events/projections-overview.md",
        title: "Projections Overview",
        raw: `# Projections Overview\n\nThis page references aggregate and projections separately.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("aggregate projections", 5, "auto");

    expect(results.length).toBeGreaterThan(1);
    expect(results[0]?.path).toBe("/events/aggregate-projections.md");
    expect((results[0]?.score ?? 0)).toBeGreaterThan(results[1]?.score ?? 0);
  });

  test("short queries default to exact mode behavior", () => {
    const chunks = chunkPages([
      {
        path: "/events/tenancy.md",
        title: "Tenancy",
        raw: `# Tenancy\n\nUse tenant data isolation patterns.`
      },
      {
        path: "/events/general.md",
        title: "General",
        raw: `# General\n\nMentions ten and unrelated text.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("ten", 5, "auto");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("/events/tenancy.md");
  });
});
