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

All tools support `format: "json" | "markdown"` (`json` default).

- `search_docs(query, limit?, offset?, mode?, debug?)`
- `list_pages(prefix?, limit?)`
- `list_headings(path)`
- `search_within_page(path, query, limit?, offset?, mode?, debug?)`
- `read_context(id, before?, after?)` (section-scoped references)
- `read_section(id, field?, offset?, maxChars?)` (paginated content windows)
- `get_status()`
- `refresh_docs(force?)`

## Recommended retrieval flow

1. `search_docs(...)`
2. Narrow with `list_headings(...)` and/or `search_within_page(...)`
3. Use `read_context(...)` for nearby references only
4. Read text with paginated `read_section(...)`

Broad page dumps are intentionally unsupported.

```text
1. search_docs(query="aggregate projections", limit=5, mode="auto")
2. search_within_page(path="/events/projections/aggregate-projections.md", query="lifecycle", limit=3)
3. read_context(id="<id>", before=1, after=1)
4. read_section(id="<id>", field="raw_text", offset=0, maxChars=1200)
5. repeat read_section(..., offset=<nextOffset>) while hasMore=true
```

## Companion docs

- [Contributing](CONTRIBUTING.md)
- [Configuration](docs/configuration.md)
- [Install and lifecycle scripts](docs/lifecycle.md)
- [Evals and telemetry mining](docs/evals.md)
- [Troubleshooting](docs/troubleshooting.md)
