# Marten Docs MCP Server

## Architecture summary

This is a local MCP server that keeps a cached copy of `https://martendb.io/llms-full.txt`, chunks it structurally, builds an in-memory hybrid search index, and exposes focused retrieval tools over stdio.

- Protocol: MCP over stdio (`stdin`/`stdout`), logging to `stderr`
- Runtime: Bun for local development, Node-compatible output via `tsc`
- Freshness model: soft TTL (12h), hard TTL (7d), conditional HTTP revalidation (`ETag`, `Last-Modified`)
- Revalidation resilience: exponential backoff with jitter after failed validations (stale cache stays available)
- Refresh safety: rebuild lock serializes concurrent refresh/index rebuild operations
- Failure reporting: recent validation failures are persisted on disk and exposed in status
- Startup behavior: stale cache is served immediately and stale entries are revalidated in background
- Search model: BM25-style lexical scoring + trigram postings with query classification (`auto`, `lexical`, `trigram`, `exact`)

## File tree

```text
.
├── eval
│   ├── baseline.json
│   └── queries.json
├── package.json
├── ROADMAP.md
├── scripts
│   ├── eval.ts
│   └── smoke.ts
├── tsconfig.json
├── src
│   ├── cache.ts
│   ├── config.ts
│   ├── index.ts
│   ├── indexer.ts
│   ├── logger.ts
│   ├── mcpServer.ts
│   ├── parser.ts
│   ├── service.ts
│   ├── types.ts
│   └── util.ts
└── test
    ├── cache.integration.test.ts
    ├── parser.test.ts
    └── search.test.ts
```

## Run and build

```bash
bun install
bun run dev
```

Build Node-compatible JS:

```bash
bun run build
node dist/index.js
```

Clean build/test artifacts:

```bash
bun run clean
```

## MCP tools

All tools accept optional `format` with values `json` (default) or `markdown`.
Chunk-bearing tool responses are bounded and include `truncation` flags when text fields are shortened.

- `search_docs(query, limit?, offset?, mode?, debug?)`
  - `mode`: `auto` (default), `lexical`, `trigram`, `exact`
  - `offset`: optional zero-based result offset for paging
  - `debug`: optional boolean for score-breakdown metadata per result
  - returns compact scored hits with snippet
- `read_section(id)`
  - returns one chunk by id
- `read_context(id, before?, after?, contextMode?)`
  - `contextMode`: `section` (default) or `page`
  - returns surrounding chunks from same section or full page scope
- `list_pages(prefix?, limit?)`
  - returns bounded page summaries for discovery and filtering
- `read_page(path, maxChunks?)`
  - bounded page retrieval
- `get_status()`
  - cache/index health and freshness metadata
- `refresh_docs(force?)`
  - explicit revalidation; `force=true` bypasses normal freshness checks

## Cache details

Default cache path:

```text
~/.cache/marten-docs-mcp
```

Override with:

```bash
MARTEN_MCP_CACHE_DIR=/some/path
```

Metadata contains:

- `sourceUrl`
- `fetchedAt`
- `lastValidatedAt`
- `etag`
- `lastModified`
- `sha256`
- `chunkCount`
- `parserVersion`
- `indexVersion`

Optional ranking weight tuning (env vars):

- `MARTEN_MCP_WEIGHT_TITLE` (default `0.4`)
- `MARTEN_MCP_WEIGHT_HEADINGS` (default `0.3`)
- `MARTEN_MCP_WEIGHT_PATH` (default `0.25`)
- `MARTEN_MCP_WEIGHT_BODY` (default `0.15`)
- `MARTEN_MCP_WEIGHT_CODE` (default `0.35`)

## Example OpenCode MCP config

```json
{
  "mcpServers": {
    "marten-docs": {
      "command": "bun",
      "args": ["run", "/Users/stijn/repositories/personal/marten_mcp/src/index.ts"],
      "env": {
        "MARTEN_MCP_CACHE_DIR": "/Users/stijn/.cache/marten-docs-mcp"
      }
    }
  }
}
```

If you prefer Node runtime from built files:

```json
{
  "mcpServers": {
    "marten-docs": {
      "command": "node",
      "args": ["/Users/stijn/repositories/personal/marten_mcp/dist/index.js"]
    }
  }
}
```

## Test and search examples

Run tests:

```bash
bun test
```

Run retrieval evaluation baseline checks:

```bash
# evaluate against recorded expected paths/headings
bun run eval

# refresh baseline expectations from current ranking
bun run eval:record
```

Note: if you intentionally change ranking logic, run `bun run eval:record` first to establish a new baseline, then run `bun run eval` for regression checks.

Quality target baseline for v1.1:

- Top-3 hit rate >= 85% (`bun run eval` enforces this threshold)

Run an end-to-end MCP smoke check (starts the server via stdio, calls `get_status` and `search_docs`):

```bash
bun run smoke
# optional custom query
bun run smoke "aggregate projections"
# markdown output
bun run smoke --markdown "aggregate projections"
```

Current tests verify:

- code-like query behavior (`session.Query<User>()`) routes well in `auto`
- prose lexical behavior (`aggregate projections`) routes well in `auto`
- exact mode handles symbol-heavy phrase variants in code snippets
- mixed prose+code query ranking favors chunks that satisfy both signals
- debug score breakdown output for search results
- parser strict/fallback/single-page modes and malformed marker counting
- cache revalidation flow for first fetch (200), conditional not-modified (304), and stale fallback on network failure

## Example query behavior

- Query: `session.Query<User>()`
  - expected: code-heavy chunks score highest (trigram/code boosts)
- Query: `aggregate projections`
  - expected: prose chunks with heading/title/body term matches score highest
- Query mode `exact`
  - expected: chunks containing exact case-insensitive phrase only

## Example tool call flows

Flow 1: topic search -> scoped context -> exact section

1. `search_docs(query="aggregate projections", limit=5, mode="auto")`
2. Pick top result `id`
3. `read_context(id="<id>", before=1, after=1, contextMode="section")`
4. If needed, `read_section(id="<id>")`

Flow 2: discover pages first, then read bounded page chunks

1. `list_pages(prefix="/events/projections", limit=20)`
2. Pick page path from results
3. `read_page(path="/events/projections/aggregate-projections.md", maxChunks=8)`

Flow 3: page-wide context for neighboring sections

1. `search_docs(query="async daemon", limit=3)`
2. Choose result `id`
3. `read_context(id="<id>", before=2, after=2, contextMode="page")`

Flow 4: human-readable output for interactive troubleshooting

1. `get_status(format="markdown")`
2. `search_docs(query="session.Query<User>()", limit=3, format="markdown")`
3. `read_section(id="<id>", format="markdown")`

## Example `get_status()` output

```json
{
  "sourceUrl": "https://martendb.io/llms-full.txt",
  "cachePath": "/Users/stijn/.cache/marten-docs-mcp",
  "hasCache": true,
  "freshness": {
    "state": "fresh",
    "softTtlHours": 12,
    "hardTtlHours": 168,
    "ageSinceValidationHours": 0.12,
    "lastValidationError": null,
    "validationBackoff": {
      "active": false,
      "retryInSeconds": null,
      "consecutiveFailures": 0
    },
    "backgroundRefresh": {
      "running": false,
      "lastStartedAt": null,
      "lastFinishedAt": null,
      "lastResult": null
    },
    "validationFailureHistory": [
      {
        "at": "2026-04-02T08:10:00.000Z",
        "message": "network unavailable"
      }
    ]
  },
  "metadata": {
    "sourceUrl": "https://martendb.io/llms-full.txt",
    "fetchedAt": "2026-04-02T08:15:00.000Z",
    "lastValidatedAt": "2026-04-02T08:15:00.000Z",
    "etag": "\"abc123\"",
    "lastModified": "Wed, 01 Apr 2026 14:20:00 GMT",
    "sha256": "...",
    "chunkCount": 742,
    "parserVersion": "v1",
    "indexVersion": "v1"
  },
  "index": {
    "ready": true,
    "chunkCount": 742,
    "pageCount": 121,
    "parserVersion": "v1",
    "indexVersion": "v1",
    "parseDiagnostics": {
      "mode": "strict",
      "pageMarkerCount": 121,
      "malformedMarkerCount": 0,
      "warnings": []
    }
  }
}
```

## Next improvements

1. Add lightweight persisted index snapshot (JSON) to speed startup on large corpora.
2. Improve parser robustness for alternate `llms-full.txt` marker variants.
3. Add a small integration test that mocks fetch responses for 200/304/network-failure revalidation paths.
