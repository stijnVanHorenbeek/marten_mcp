# Troubleshooting

## Reset local cache

Remove cache files under `MARTEN_MCP_CACHE_DIR` (default `~/.cache/marten-docs-mcp`) and refresh:

```bash
bun run dev
```

Then call MCP tool:

```text
refresh_docs(force=true)
```

Typical cache files include:

- `llms-full.txt`
- `metadata.json`
- `validation-history.json`
- `index-snapshot.json`
- `cache.db`

## Stale fallback / freshness issues

Use:

```text
get_status()
```

Check:

- `freshness.lastValidationError`
- `freshness.validationBackoff`
- `freshness.validationFailureHistory`
- `freshness.backgroundRefresh`

## Parser diagnostics

`get_status().index.parseDiagnostics` provides:

- `mode`
- `pageMarkerCount`
- `malformedMarkerCount`
- `warnings`

## Connectivity and runtime checks

Quick diagnostics:

```bash
bun run doctor
```

Smoke MCP tools locally:

```bash
bun run smoke
```

Node sqlite mode requires Node 22+ (`node:sqlite`).
