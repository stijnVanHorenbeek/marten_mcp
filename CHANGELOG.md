# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

## [0.2.1] - 2026-04-02

### Fixed
- Quick installer now resolves latest release tag reliably from GitHub API.
- Quick installer supports explicit version pinning via `--version`.
- README quick install examples now use the supported pinned-version invocation.

## [0.2.0] - 2026-04-02

### Added
- Stale-while-revalidate startup behavior with background revalidation.
- Revalidation backoff with jitter and persisted validation failure history.
- Cache index snapshot reuse for faster warm starts.
- Runtime-inferred storage mode (`sqlite` on Bun, `json` on Node by default).
- SQLite cache backend using a single-file DB.
- Persisted postings/index state hydration for faster warm starts.
- JSON-to-sqlite migration command (`bun run migrate:sqlite`).
- Structured stderr logging with event ids and context.
- `doctor` diagnostics script for cache and network checks.
- `perf:smoke` metrics script.
- Install lifecycle scripts: `install.ts`, `verify.ts`, `upgrade.ts`, `uninstall.ts`.
- POSIX lifecycle wrapper (`lifecycle.sh`) for install/verify/upgrade/uninstall commands.
- `quickinstall.sh` script for one-command install from GitHub release artifacts.
- Tag-triggered GitHub release workflow with packaged `bundle/` and `dist/` artifacts.

### Changed
- Search quality improvements including BM25 lexical scoring and better token normalization.
- MCP ergonomics additions: `list_pages`, `search_docs` offset paging, `read_context` mode, markdown format.
- Bundling moved to Bun (`Bun.build`) with minified distributable output.
- Node sqlite runtime path uses Node 22+ `node:sqlite`.
- CI now validates bundled artifact smoke tests on Bun and Node runtimes.
- Release pipeline now enforces git tag/package version alignment.

## [0.1.0] - 2026-04-02

### Added
- Initial local MCP server for Marten docs retrieval/search over stdio.
- Cache/download/TTL revalidation flow for `llms-full.txt`.
- Structural parsing/chunking and hybrid lexical+trigram search.
- MCP tools: `search_docs`, `read_section`, `read_context`, `read_page`, `list_pages`, `get_status`, `refresh_docs`.
