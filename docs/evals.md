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

Mined output is a candidate source for manual review before updating `eval/baseline.json`.
