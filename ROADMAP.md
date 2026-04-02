# Marten Docs MCP Roadmap

Track progress by checking off tasks as we complete them.

## Milestone 1: Retrieval Quality Baseline (v1.1)

Goal: Make search quality measurable and safe to iterate.

- [x] Create a query evaluation suite with 25-50 realistic Marten queries
- [x] Define expected top results (path + section-level target) for each query
- [x] Add an automated ranking regression test command (`bun run eval`)
- [x] Add score breakdown output (lexical/trigram/boosts) behind a debug flag
- [x] Document quality targets (for example top-3 hit rate baseline)

## Milestone 2: Search Improvements (v1.2)

Goal: Improve ranking quality without adding embeddings or DB complexity.

- [x] Add BM25-style lexical scoring (replace/augment current term overlap)
- [x] Improve tokenization for C# identifiers (`StoreAsync`, `IDocumentSession`, generics)
- [x] Normalize query/doc forms (kebab/snake/camel and singular/plural variants)
- [x] Add configurable field weights (title, headings, path, body, code)
- [x] Add more exact phrase handling for short queries and symbol-heavy queries
- [x] Expand tests for code-heavy and prose-heavy mixed queries

## Milestone 3: MCP Tool Ergonomics (v1.3)

Goal: Make retrieval easier to use and less chatty.

- [x] Add `list_pages(prefix?, limit?)`
- [x] Add paging to `search_docs` (`offset` or cursor)
- [x] Add explicit `contextMode` in `read_context` (`section` or `page`)
- [x] Add optional compact markdown result format for human-readable output
- [x] Ensure all tool outputs stay bounded and predictable in size
- [x] Add examples for tool call flows in README

## Milestone 4: Cache/Runtime Reliability (v1.4)

Goal: Keep behavior stable under flaky network and repeated runs.

- [x] Add revalidation backoff/jitter after network failures
- [x] Add refresh lock to prevent concurrent refresh/index rebuild races
- [x] Persist and report validation failure history (recent failures + timestamps)
- [x] Serve cached index immediately and revalidate in background (stale-while-revalidate)
- [x] Add startup index snapshot load path (JSON) to speed warm start
- [x] Add tests for lock behavior and repeated failure scenarios

## Milestone 5: Observability and DX (v1.5)

Goal: Make local operation and debugging straightforward.

- [x] Add structured stderr logging (event ids + context)
- [x] Add `doctor` command/script for cache path, permissions, and fetch checks
- [x] Add CI for Bun + Node (test, build, smoke)
- [x] Add release notes/changelog process
- [x] Add troubleshooting section (cache reset, stale fallback, parser diagnostics)
- [x] Add perf smoke metrics (startup time, index size, search latency sample)

## Ongoing Maintenance

- [ ] Keep parser hardening tests updated against real `llms-full.txt` changes
- [ ] Review tool output shapes for backward compatibility before changes
- [ ] Re-run quality eval suite before each release
- [ ] Track parser diagnostics trends (`mode`, `pageMarkerCount`, `malformedMarkerCount`)
- [ ] Prune/refresh roadmap quarterly

## Suggested Execution Order

1. Milestone 1 (baseline + eval harness)
2. Milestone 2 (ranking changes measured by Milestone 1)
3. Milestone 3 (tool UX)
4. Milestone 4 (runtime hardening)
5. Milestone 5 (ops + team adoption)

## Definition of Done (per milestone)

- [x] Tests green (`bun test`)
- [x] Build green (`bun run build`)
- [x] Smoke green (`bun run smoke`)
- [x] No unbounded MCP responses
- [x] README updated for changed behavior
