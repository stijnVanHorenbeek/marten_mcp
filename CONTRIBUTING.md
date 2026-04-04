# Contributing

Thanks for contributing.

## Local development

```bash
bun install
bun run dev
```

## Validation commands

Run these before opening a PR:

```bash
bun test
bun run build
bun run smoke
```

Useful additional checks:

```bash
bun run doctor
bun run perf:smoke
```

## Contributor expectations

- Keep changes focused and minimal.
- Update docs/tests when behavior changes.
- Prefer preserving retrieval discipline: search first, narrow selection, focused reads.
- Avoid adding broad-read behavior.

## Before submitting changes

- Tests pass locally (`bun test`).
- Type/build check passes (`bun run build`).
- MCP smoke check succeeds (`bun run smoke`).
- Any changed docs are accurate and match the current tool surface.
