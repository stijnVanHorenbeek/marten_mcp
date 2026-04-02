# Marten Docs MCP Server

## Architecture summary

This is a local MCP server that keeps a cached copy of `https://martendb.io/llms-full.txt`, chunks it structurally, builds an in-memory hybrid search index, and exposes focused retrieval tools over stdio.

- Protocol: MCP over stdio (`stdin`/`stdout`), logging to `stderr`
- Runtime: Bun for local development, Node-compatible output via `tsc`
- Freshness model: soft TTL (12h), hard TTL (7d), conditional HTTP revalidation (`ETag`, `Last-Modified`)
- Search model: lexical inverted postings + trigram postings with query classification (`auto`, `lexical`, `trigram`, `exact`)

## File tree

```text
.
├── package.json
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

- `search_docs(query, limit?, mode?)`
  - `mode`: `auto` (default), `lexical`, `trigram`, `exact`
  - returns compact scored hits with snippet
- `read_section(id)`
  - returns one chunk by id
- `read_context(id, before?, after?)`
  - returns surrounding chunks from same page
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

Run an end-to-end MCP smoke check (starts the server via stdio, calls `get_status` and `search_docs`):

```bash
bun run smoke
# optional custom query
bun run smoke "aggregate projections"
```

Current tests verify:

- code-like query behavior (`session.Query<User>()`) routes well in `auto`
- prose lexical behavior (`aggregate projections`) routes well in `auto`
- cache revalidation flow for first fetch (200), conditional not-modified (304), and stale fallback on network failure

## Example query behavior

- Query: `session.Query<User>()`
  - expected: code-heavy chunks score highest (trigram/code boosts)
- Query: `aggregate projections`
  - expected: prose chunks with heading/title/body term matches score highest
- Query mode `exact`
  - expected: chunks containing exact case-insensitive phrase only

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
    "lastValidationError": null
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
