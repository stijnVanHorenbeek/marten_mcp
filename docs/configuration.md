# Configuration

## Cache directory

Default cache directory:

```text
~/.cache/marten-docs-mcp
```

Override:

```bash
MARTEN_MCP_CACHE_DIR=/some/path
```

## Source URL override

Default source URL:

```text
https://martendb.io/llms-full.txt
```

Override:

```bash
MARTEN_MCP_SOURCE_URL=https://example.com/llms-full.txt
```

## Storage mode

Default behavior:

- Bun runtime: `sqlite`
- Node runtime: `json`

Overrides:

```bash
MARTEN_MCP_STORAGE_MODE=sqlite   # or json
MARTEN_MCP_SQLITE_PATH=~/.cache/marten-docs-mcp/cache.db
MARTEN_MCP_SQLITE_DRIVER=auto    # auto | bun-sqlite | node-sqlite
```

## MCP runtime limits

These limits are used by MCP retrieval tools to clamp read/search arguments.

```bash
MARTEN_MCP_MAX_SEARCH_LIMIT=5
MARTEN_MCP_MAX_WITHIN_PAGE_LIMIT=4
MARTEN_MCP_MAX_READ_CHARS=3000
```

Defaults shown above. Values are range-clamped.

## Cache freshness TTL overrides

Optional cache freshness overrides:

```bash
MARTEN_MCP_SOFT_TTL_MS=43200000
MARTEN_MCP_HARD_TTL_MS=604800000
```

`MARTEN_MCP_HARD_TTL_MS` is clamped to be at least `MARTEN_MCP_SOFT_TTL_MS`.

## Telemetry

Telemetry is enabled by default and written as daily JSONL files.

Defaults:

- Path: `~/.cache/marten-docs-mcp/telemetry`
- File layout: `YYYY-MM-DD.jsonl`
- Retention: `14` days (best-effort pruning)

Overrides:

```bash
MARTEN_MCP_TELEMETRY_PATH=/custom/path
MARTEN_MCP_TELEMETRY_RETENTION_DAYS=30
MARTEN_MCP_TELEMETRY_DISABLED=1
```

If `MARTEN_MCP_TELEMETRY_PATH` points to a file ending in `.jsonl`, telemetry is appended to that file instead of daily files.

## Ranking-related environment variables

Optional weight tuning:

```bash
MARTEN_MCP_WEIGHT_TITLE=0.4
MARTEN_MCP_WEIGHT_HEADINGS=0.3
MARTEN_MCP_WEIGHT_PATH=0.25
MARTEN_MCP_WEIGHT_BODY=0.15
MARTEN_MCP_WEIGHT_CODE=0.35
```
