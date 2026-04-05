# Marten Docs MCP Server

Local MCP server for focused Marten documentation retrieval.

It caches `https://martendb.io/llms-full.txt`, builds a local index, and exposes a narrow retrieval surface so agents search first, then progressively narrow to specific sections.

## Quick install

### macOS / Linux

```bash
# Install latest release
curl -fsSL https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.sh | sh

# Print a Copilot-compatible config snippet
curl -fsSL https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.sh | sh -s -- --client copilot
```

### Windows PowerShell

```powershell
# Install latest release
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.ps1)))

# Print a Copilot-compatible config snippet
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/stijnVanHorenbeek/marten_mcp/master/scripts/quickinstall.ps1))) -Client copilot
```

## Example SKILL.md

Example [SKILL.md](examples/skills/martendb/SKILL.md) is included

## MCP config examples

### OpenCode

```json
{
  "mcp": {
    "marten-docs": {
      "type": "local",
      "command": ["marten-docs-mcp"],
      "environment": {
        "MARTEN_MCP_CACHE_DIR": "~/.cache/marten-docs-mcp",
        "MARTEN_MCP_STORAGE_MODE": "auto",
        "MARTEN_MCP_SQLITE_PATH": "~/.cache/marten-docs-mcp/cache.db"
      }
    }
  }
}
```

### GitHub Copilot Chat

```json
{
  "mcpServers": {
    "marten-docs": {
      "type": "local",
      "command": "marten-docs-mcp",
      "args": [],
      "env": {
        "MARTEN_MCP_CACHE_DIR": "~/.cache/marten-docs-mcp",
        "MARTEN_MCP_STORAGE_MODE": "auto",
        "MARTEN_MCP_SQLITE_PATH": "~/.cache/marten-docs-mcp/cache.db"
      },
      "tools": ["*"]
    }
  }
}
```

## MCP tools

- `search_docs(query, limit?, offset?)`
- `search_within_page(path, query, limit?, offset?)`
- `list_headings(path)`
- `read_section(id, segmentIndex?, offset?, maxChars?)` (returns one local segment plus compact `neighbors.before/after` refs)
- `read_context(id, before?, after?)` (nearby refs only)
- `list_pages(prefix?, limit?)` (discovery only when search is insufficient)
- `get_status()`
- `refresh_docs(force?)`

## Recommended retrieval flow

1. `search_docs(...)`
2. Narrow with `list_headings(...)` and/or `search_within_page(...)`
3. Read one chunk with `read_section(...)`
4. Use `read_context(...)` only for nearby references

Broad page dumps are intentionally unsupported.

```text
1. search_docs(query="aggregate projections", limit=3)
2. search_within_page(path="/events/projections/aggregate-projections.md", query="lifecycle", limit=3)
3. read_section(id="<id>", offset=0, maxChars=1200)
4. read_context(id="<id>", before=1, after=1)
5. repeat read_section(..., offset=<nextOffset>) while hasMore=true
```

## Companion docs

- [Contributing](CONTRIBUTING.md)
- [Configuration](docs/configuration.md)
- [Install and lifecycle scripts](docs/lifecycle.md)
- [Evals and telemetry mining](docs/evals.md)
- [Troubleshooting](docs/troubleshooting.md)
