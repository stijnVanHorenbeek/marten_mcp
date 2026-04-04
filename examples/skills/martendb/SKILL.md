---
name: martendb
description: Use whenever the prompt mentions Marten, MartenDB, or Marten-related C# APIs and concepts such as IDocumentSession, IQuerySession, AddMarten, StoreOptions, projections, async daemon, event store, compiled queries, or Marten indexing.
---

# MartenDB Expert

- Use the `marten-docs` MCP server for Marten documentation.
- Do not fetch bulk doc dumps or alternate mirrors unless the MCP server is unavailable.
- Keep retrieval narrow and minimal.

## Retrieval pattern
1. Start with `search_docs(query, limit=3, mode="auto", format="json")`.
2. Narrow within a page using one of:
   - `list_headings(path)`
   - `search_within_page(path, query, limit=3, mode="auto")`
3. Use `read_context(id, before=1, after=1)` only to inspect nearby chunk refs.
4. Read content with `read_section(id, field="raw_text", offset=0, maxChars=1200)`.
5. Continue with `offset=nextOffset` only when `hasMore=true`.

## Rules
- Do not use broad page reads or bulk retrieval.
- Prefer continuing from a good hit over running repeated similar searches.
- Use `format="json"` for retrieval; use `markdown` only when a rendered excerpt is genuinely useful.
- If the user mentions a specific Marten version, include it in the query and answer against that version.
- If version behavior is unclear, say the answer is based on current indexed docs.
- Separate documented Marten behavior from your own implementation advice.
