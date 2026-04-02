# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

### Added
- Stale-while-revalidate startup behavior with background revalidation.
- Revalidation backoff with jitter and persisted validation failure history.
- Cache index snapshot reuse for faster warm starts.
- Structured stderr logging with event ids and context.
- `doctor` diagnostics script for cache and network checks.

### Changed
- Search quality improvements including BM25 lexical scoring and better token normalization.
- MCP ergonomics additions: `list_pages`, `search_docs` offset paging, `read_context` mode, markdown format.

## [0.1.0] - 2026-04-02

### Added
- Initial local MCP server for Marten docs retrieval/search over stdio.
- Cache/download/TTL revalidation flow for `llms-full.txt`.
- Structural parsing/chunking and hybrid lexical+trigram search.
- MCP tools: `search_docs`, `read_section`, `read_context`, `read_page`, `list_pages`, `get_status`, `refresh_docs`.
