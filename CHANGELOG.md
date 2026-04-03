# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

## [0.2.5] - 2026-04-03

### Added
- Telemetry eval miner now supports clustering similar queries (term normalization + Jaccard thresholding) so mined candidates can accumulate across paraphrased search prompts.
- Telemetry mining output now includes `queryVariants` to show which query phrasings were grouped into each candidate.

### Changed
- Retrieval ranking was tuned for long, context-heavy prompts with query profiling, hybrid rank fusion, intent-aware boosts/penalties, and path-level deduplication.
- Eval baselines and queries were updated for ambiguous `FetchLatest` intent and more realistic phrasing (`pathAnyOf` for shared intent pages).
- Mined eval outputs are now directed to `eval/generated/` and ignored in git to keep generated artifacts out of tracked changes.

### Fixed
- MCP server startup no longer blocks on initial docs fetch/index build, reducing first-run smoke timeout flakiness in CI.
- Smoke script timeout handling and budget were hardened (`300s`) to avoid first-attempt request timeouts on cold runners.

## [0.2.4] - 2026-04-03

### Changed
- Parser and chunking pipeline refactored to structural blocks with fence-aware heading parsing, admonition normalization, and boilerplate stripping.
- Chunk generation now preserves heading ancestry and uses block-aware splitting for improved retrieval boundaries.
- Trigram indexing now uses normalized prose plus extracted code (`body_text` + `code_text`) instead of raw fenced markdown.
- Eval queries were refined to more realistic intent phrasing and baseline expectations were aligned to canonical doc pages.

## [0.2.2] - 2026-04-03

### Added
- Example OpenCode Marten skill at `examples/skills/martendb/SKILL.md`.

### Fixed
- Quick installer now prints an OpenCode-compatible `mcp` config snippet (`type: local`, `command` array, `environment`).
- Quick installer now supports `--client copilot` and prints a `mcpServers` snippet compatible with GitHub Copilot Chat config.
- `search_docs` markdown output now includes chunk `id` for easier follow-up `read_section`/`read_context` calls.

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
