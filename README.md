# Marten Docs MCP Server

## Quick install

Install from the latest GitHub release:

```bash
curl -fsSL https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.sh | sh
```

Print a GitHub Copilot Chat-compatible snippet (`~/.copilot/mcp-config.json` shape):

```bash
curl -fsSL https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.sh | sh -s -- --client copilot
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.sh | sh -s -- --version v0.2.1
```

This installs the launcher and prints an OpenCode `opencode.jsonc` snippet (`mcp` section) you can paste into your client config.

## Architecture summary

This is a local MCP server that keeps a cached copy of `https://martendb.io/llms-full.txt`, chunks it structurally, builds an in-memory hybrid search index, and exposes focused retrieval tools over stdio.

- Protocol: MCP over stdio (`stdin`/`stdout`), logging to `stderr`
- Logging: structured JSON stderr records with `eventId`, `level`, timestamp, and optional context
- Runtime: Bun for local development, Node 22+ runtime support
- Storage: runtime-inferred by default (`sqlite` on Bun, `json` on Node) with env override
- Freshness model: soft TTL (12h), hard TTL (7d), conditional HTTP revalidation (`ETag`, `Last-Modified`)
- Revalidation resilience: exponential backoff with jitter after failed validations (stale cache stays available)
- Refresh safety: rebuild lock serializes concurrent refresh/index rebuild operations
- Failure reporting: recent validation failures are persisted on disk and exposed in status
- Startup behavior: stale cache is served immediately and stale entries are revalidated in background
- Warm start speed: parser/chunk output snapshot is cached on disk and reused when hashes match
- Index hydration: in-memory index can be hydrated from persisted postings snapshot (avoids retokenizing on startup)
- Search model: BM25-style lexical scoring + trigram postings with query classification (`auto`, `lexical`, `trigram`, `exact`)

## File tree

```text
.
├── .github
│   └── workflows
│       ├── ci.yml
│       └── release.yml
├── CHANGELOG.md
├── eval
│   ├── baseline.json
│   └── queries.json
├── package.json
├── scripts
│   ├── bundle.ts
│   ├── doctor.ts
│   ├── eval.ts
│   ├── install.ts
│   ├── lifecycle-lib.ts
│   ├── lifecycle.sh
│   ├── migrate-to-sqlite.ts
│   ├── perf-smoke.ts
│   ├── quickinstall.sh
│   ├── smoke.ts
│   ├── uninstall.ts
│   ├── upgrade.ts
│   └── verify.ts
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
│   ├── storage.ts
│   ├── types.ts
│   └── util.ts
└── test
    ├── cache.integration.test.ts
    ├── logger.test.ts
    ├── parser.test.ts
    ├── search.test.ts
    └── service.lock.test.ts
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

Build Node-compatible JS without sourcemaps (release-oriented):

```bash
bun run build:dist:release
```

Create a minified distributable bundle:

```bash
bun run build:bundle
node bundle/index.js

# debug bundle with sourcemap
bun run build:bundle:debug

# full release build (tsc + bundle)
bun run build:release
```

Notes:

- The bundle intentionally keeps `bun:sqlite` and `node:sqlite` as runtime externals.
- Node sqlite mode requires Node 22+ (`node:sqlite`).

Clean build/test artifacts:

```bash
bun run clean
```

## Install lifecycle scripts

Primary workflow (TS scripts):

```bash
bun run install:local
bun run verify:local
bun run upgrade:local
bun run uninstall:local
```

POSIX wrappers (call TS scripts):

```bash
./scripts/lifecycle.sh install
./scripts/lifecycle.sh verify
./scripts/lifecycle.sh upgrade
./scripts/lifecycle.sh uninstall
```

Install behavior:

- Copies `bundle/index.js` into `${XDG_DATA_HOME:-~/.local/share}/marten-docs-mcp` by default.
- Creates launcher `marten-docs-mcp` in bin dir priority order:
  1. `--bin-dir`
  2. `MARTEN_MCP_BIN_DIR`
  3. `XDG_BIN_DIR`
  4. `~/bin` (if available/creatable)
  5. `~/.local/bin`
- Prints an MCP config snippet by default.
- Writes config file only when `--write-config` is provided.

Installer path overrides:

```bash
MARTEN_MCP_INSTALL_DIR=/custom/install/root
MARTEN_MCP_BIN_DIR=/custom/bin
MARTEN_MCP_CACHE_DIR=/custom/cache
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

Storage mode controls:

```bash
# force storage mode
MARTEN_MCP_STORAGE_MODE=sqlite   # or json

# sqlite db file path (only used in sqlite mode)
MARTEN_MCP_SQLITE_PATH=~/.cache/marten-docs-mcp/cache.db

# sqlite driver: auto | bun-sqlite | node-sqlite
MARTEN_MCP_SQLITE_DRIVER=auto
```

Notes:

- In Bun, sqlite mode uses Bun's sqlite driver automatically.
- In Node (22+), sqlite mode uses `node:sqlite`; older Node should use json mode.

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
      "args": ["run", "src/index.ts"],
      "env": {
        "MARTEN_MCP_CACHE_DIR": "~/.cache/marten-docs-mcp"
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
      "args": ["dist/index.js"]
    }
  }
}
```

## Test and search examples

Run tests:

```bash
bun test
```

Run environment and cache diagnostics:

```bash
bun run doctor
# machine-readable output
bun run doctor --json
```

Migrate existing JSON cache files to sqlite:

```bash
bun run migrate:sqlite
```

Run perf smoke metrics:

```bash
bun run perf:smoke
# machine-readable output
bun run perf:smoke --json
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
# run smoke against bundled runtime in Bun
bun run smoke -- --server bun-bundle "aggregate projections"
# run smoke against bundled runtime in Node
bun run smoke -- --server node-bundle "aggregate projections"
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
  "storageMode": "sqlite",
  "cachePath": "~/.cache/marten-docs-mcp/cache.db",
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

## Troubleshooting

- Cache reset: remove files under `MARTEN_MCP_CACHE_DIR` (`llms-full.txt`, `metadata.json`, `validation-history.json`, `index-snapshot.json`, `cache.db`) and run `refresh_docs(force=true)`.
- Stale fallback visible: check `get_status().freshness.lastValidationError`, `validationBackoff`, and `validationFailureHistory`.
- Parser issues: inspect `get_status().index.parseDiagnostics` for `mode`, `pageMarkerCount`, `malformedMarkerCount`, and warnings.
- Connectivity check: run `bun run doctor` to verify source reachability and cache path writability.
- Node sqlite mode requires Node 22+ (`node:sqlite`).

## Release notes process

- Keep release notes in `CHANGELOG.md`.
- Add entries under `[Unreleased]` as work lands.
- On release, move relevant entries to a dated version heading and start a fresh `[Unreleased]` section.
- Bump `package.json` version and create a matching git tag (`vX.Y.Z`).
- Push the tag to trigger `.github/workflows/release.yml`, which builds artifacts and publishes a GitHub release.

## CI

- GitHub Actions workflow: `.github/workflows/ci.yml`.
- Bun job gates: `bun test`, `bun run build:release`, smoke against bundled runtime (`bun-bundle`).
- Node compatibility job gates: `bun run build:release`, smoke against bundled runtime (`node-bundle`) with sqlite mode.
- Release workflow: `.github/workflows/release.yml` (triggered by `v*.*.*` tags; validates tag/version match).
