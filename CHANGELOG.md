# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

## [0.2.7] - 2026-04-04

### Added
- Added `CONTRIBUTING.md` and split companion docs under `docs/` (`configuration`, `evals`, `lifecycle`, `troubleshooting`) to separate user-facing guidance from contributor/operations material.
- Added focused retrieval tools and surfaces for page narrowing: `list_headings` and `search_within_page`.
- Added paginated section reads via `read_section(id, field, offset, maxChars)` window metadata (`nextOffset`, `hasMore`).

### Changed
- `search_docs(mode="auto")` now uses genuine hybrid lexical+trigram blending, with query-kind weighting and typo-aware trigram biasing when lexical evidence is weak.
- Top-level `README.md` is now concise and user-facing, with companion-doc links for advanced workflows.
- Eval record flow now defaults to candidate baseline output and requires explicit acknowledgement flags to overwrite canonical baseline.
- Telemetry now records minimized retrieval metadata and uses daily JSONL storage with retention controls.

### Fixed
- `list_pages(prefix)` now uses true prefix semantics instead of substring matching.
- MCP server-reported version is now sourced from `package.json`.
- `read_context` contract is section-scoped and bounded consistently with runtime behavior.

### Security
- Added an MIT license file to clarify repository licensing.

## [0.2.6] - 2026-04-03

### Added
- Added Windows quick install script at `scripts/quickinstall.ps1` that downloads release artifacts, installs a launcher, and prints MCP config snippets for OpenCode or Copilot.
- Added a tiny smoke docs fixture at `eval/telemetry/smoke-llms.txt` for deterministic CI cache seeding.

### Fixed
- CI smoke steps now seed a local docs cache before running smoke checks, removing dependence on external docs origin availability during first-run startup.
- Docs source URL can now be overridden with `MARTEN_MCP_SOURCE_URL` for controlled environments and smoke diagnostics.

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
