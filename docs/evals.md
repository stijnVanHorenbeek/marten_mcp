# Evals and telemetry mining

## Run eval

Evaluate current retrieval quality against `eval/baseline.json`:

```bash
bun run eval
```

The eval script reports top-1 and top-3 hit rates and uses a top-3 target threshold of `85%`.

`eval/baseline.json` is the primary product benchmark. Keep it focused on real agent-style Marten questions.

Keep externally sourced candidate prompts separate until reviewed:

- `eval/candidates/stackoverflow-v8-candidates.json`

## Recording baseline expectations

Record mode uses current top results to generate baseline rows.

Default safe behavior:

```bash
bun run eval --record
```

This writes a candidate file to:

```text
eval/generated/baseline-candidate.json
```

Canonical baseline is unchanged unless you explicitly opt in.

### Explicit canonical overwrite

```bash
bun run eval --record --write-baseline --ack-overwrite-baseline
```

You can also direct output to a specific path:

```bash
bun run eval --record --record-out /tmp/my-baseline.json
```

## Mining eval candidates from telemetry

Mine query-to-path candidates from telemetry logs:

```bash
bun run eval:mine -- --input ~/.cache/marten-docs-mcp/telemetry/2026-04-04.jsonl --output eval/generated/mined-candidates.json
```

Useful tuning flags:

- `--min-searches`
- `--min-selections`
- `--window-ms`
- `--min-share`
- `--cluster-similarity`
- `--cluster-min-shared-terms`


## Trace tooling

Use telemetry traces to inspect model/tool behavior for one run:

```bash
bun run trace:show -- --latest
bun run trace:analyze -- --latest
bun run trace:show -- --input ~/.cache/marten-docs-mcp/telemetry/2026-04-05.jsonl --process-id 85532
bun run trace:analyze -- --input ~/.cache/marten-docs-mcp/telemetry/2026-04-05.jsonl --process-id 85532
```

Runtime telemetry files are stored under `~/.cache/marten-docs-mcp/telemetry` by default (or `MARTEN_MCP_TELEMETRY_PATH` when set).
`--latest` selects the newest `*.jsonl` file from the resolved telemetry location.

## Retrieval inspectors

Use local inspection scripts to debug chunk structure and query ranking:

```bash
bun run inspect:chunk -- --id /documents/querying/byid.md::1 --context 1
bun run inspect:query -- --query "LoadManyAsync" --show-profile
```
Mined output is a candidate source for manual review before updating `eval/baseline.json`.
