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

  test("path terms participate in candidate retrieval", () => {
    const chunks = chunkPages([
      {
        path: "/events/projections/advanced-mapping.md",
        title: "Advanced Mapping",
        raw: `# Advanced Mapping\n\nThis section focuses on internals.`
      },
      {
        path: "/documents/querying.md",
        title: "Querying",
        raw: `# Querying\n\nGeneral query docs.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("events projections", 5, "auto");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("/events/projections/advanced-mapping.md");
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

  test("read context remains section-scoped", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections

## Lifecycle

Lifecycle text one.

## Configuration

Configuration text.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const lifecycleChunk = chunks.find((chunk) => chunk.headings.includes("Lifecycle"));
    expect(lifecycleChunk).toBeTruthy();

    const context = index.getContext(lifecycleChunk!.id, 10, 10, "section");
    expect(context.length).toBeGreaterThan(0);
    expect(context.some((chunk) => chunk.headings.includes("Configuration"))).toBe(false);
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

  test("debug mode includes score breakdown fields", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nUse aggregate projections for snapshots.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("aggregate projections", 3, "auto", true);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.debug).toBeTruthy();
    expect(results[0]?.debug?.decidedMode).toBe("auto");
    expect(results[0]?.debug?.autoBlend).toBe(true);
    expect(typeof results[0]?.debug?.phraseBoost).toBe("number");
  });

  test("auto mode uses blended ranking for mixed queries", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nLifecycle and snapshot guidance.`
      },
      {
        path: "/documents/querying.md",
        title: "Querying",
        raw: `# Querying\n\nUse session.Query<User>() for read models.`
      },
      {
        path: "/events/projections/read-models.md",
        title: "Read Models",
        raw: `# Read Models\n\nUse aggregate projections and session.Query<User>() together.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("aggregate projections session.Query<User>()", 5, "auto", true);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.debug?.decidedMode).toBe("auto");
    expect(results[0]?.debug?.autoBlend).toBe(true);
    expect(results.some((row) => row.path === "/events/projections/read-models.md")).toBe(true);
  });

  test("auto mode biases trigram when lexical evidence is absent", () => {
    const chunks = chunkPages([
      {
        path: "/events/projections/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nProjection lifecycle guidance and aggregate behavior.`
      },
      {
        path: "/documents/querying.md",
        title: "Querying",
        raw: `# Querying\n\nLINQ session querying patterns.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const query = "agregate projeccions lifecyle";
    const lexical = index.search(query, 3, "lexical");
    const trigram = index.search(query, 3, "trigram");
    const auto = index.search(query, 3, "auto", true);

    expect(lexical.length).toBe(0);
    expect(trigram.length).toBeGreaterThan(0);
    expect(auto.length).toBeGreaterThan(0);
    expect(auto[0]?.path).toBe(trigram[0]?.path);
    expect(auto[0]?.debug?.autoBlend).toBe(true);
  });

  test("symbol-heavy exact query matches flexible code formatting", () => {
    const chunks = chunkPages([
      {
        path: "/documents/querying.md",
        title: "Querying",
        raw: `# Querying\n\n\`session.Query <User> ()\` is valid in examples.`
      },
      {
        path: "/events/projections.md",
        title: "Projections",
        raw: `# Projections\n\nProjection lifecycle notes.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("session.Query<User>()", 3, "exact");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("/documents/querying.md");
  });

  test("mixed prose and code query keeps combined-content page in top results", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nThis section explains aggregate projection lifecycle.`
      },
      {
        path: "/documents/querying.md",
        title: "Querying",
        raw: `# Querying\n\nUse \`session.Query<User>()\` in read models.`
      },
      {
        path: "/events/projections/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\nUse \`session.Query<User>()\` while discussing projection lifecycle and aggregate projections.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const results = index.search("aggregate projections session.Query<User>()", 3, "auto", true);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.debug?.decidedMode).toBe("auto");
    expect(results.some((row) => row.path === "/events/projections/aggregate-projections.md")).toBe(true);
  });

  test("list pages supports prefix filtering and limits", () => {
    const chunks = chunkPages([
      {
        path: "/events/a.md",
        title: "Events A",
        raw: `# Events A\n\nAlpha`
      },
      {
        path: "/events/b.md",
        title: "Events B",
        raw: `# Events B\n\nBeta`
      },
      {
        path: "/documents/a.md",
        title: "Documents A",
        raw: `# Documents A\n\nGamma`
      },
      {
        path: "/archive/events/history.md",
        title: "History",
        raw: `# History\n\nShould not match prefix /events`
      }
    ]);

    const index = new HybridIndex(chunks);
    const pages = index.listPages("/events", 1);

    expect(pages.length).toBe(1);
    expect(pages[0]?.path.startsWith("/events")).toBe(true);
  });

  test("search within page returns chunk-level results with offset", () => {
    const chunks = chunkPages([
      {
        path: "/events/aggregate-projections.md",
        title: "Aggregate Projections",
        raw: `# Aggregate Projections\n\n## Lifecycle\n\naggregate projections lifecycle\n\n## Runtime\n\naggregate projections runtime`
      }
    ]);

    const index = new HybridIndex(chunks);
    const first = index.searchWithinPage("/events/aggregate-projections.md", "aggregate projections", 1, "auto", false, 0);
    const second = index.searchWithinPage("/events/aggregate-projections.md", "aggregate projections", 1, "auto", false, 1);

    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0]?.path).toBe("/events/aggregate-projections.md");
    expect(second[0]?.id).not.toBe(first[0]?.id);
  });

  test("search supports offset paging", () => {
    const chunks = chunkPages([
      {
        path: "/events/one.md",
        title: "One",
        raw: `# One\n\naggregate projections example one`
      },
      {
        path: "/events/two.md",
        title: "Two",
        raw: `# Two\n\naggregate projections example two`
      },
      {
        path: "/events/three.md",
        title: "Three",
        raw: `# Three\n\naggregate projections example three`
      }
    ]);

    const index = new HybridIndex(chunks);
    const firstPage = index.search("aggregate projections", 2, "auto", false, 0);
    const secondPage = index.search("aggregate projections", 2, "auto", false, 2);

    expect(firstPage.length).toBe(2);
    expect(secondPage.length).toBe(1);
    expect(secondPage[0]?.id).not.toBe(firstPage[0]?.id);
    expect(secondPage[0]?.id).not.toBe(firstPage[1]?.id);
  });

  test("long review-style query favors sessions docs over generic pages", () => {
    const chunks = chunkPages([
      {
        path: "/migration-guide.md",
        title: "Migration Guide",
        raw: `# Migration Guide\n\nThis page discusses improvements and upgrades in general terms.`
      },
      {
        path: "/documents/sessions.md",
        title: "Document Sessions",
        raw: `# Document Sessions\n\nUse IDocumentSession for writes and IQuerySession for read-only querying. Query<T>() and LoadAsync are covered here.`
      },
      {
        path: "/configuration/hostbuilder.md",
        title: "Host Builder",
        raw: `# Host Builder\n\nService registration and host setup.`
      }
    ]);

    const index = new HybridIndex(chunks);
    const query =
      "In PersonInformationService.cs, review IDocumentSession/IQuerySession usage and Marten query/index/projection improvements.";
    const results = index.search(query, 5, "auto");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe("/documents/sessions.md");
  });
});
