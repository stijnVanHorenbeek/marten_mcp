# Install and lifecycle scripts

The local lifecycle scripts use `bundle/index.js`, so build release artifacts first:

```bash
bun run build:release
```

## Primary lifecycle commands

```bash
bun run install:local
bun run verify:local
bun run upgrade:local
bun run uninstall:local
```

## POSIX wrapper

```bash
./scripts/lifecycle.sh install
./scripts/lifecycle.sh verify
./scripts/lifecycle.sh upgrade
./scripts/lifecycle.sh uninstall
```

## Notes

- `install:local` fails if `bundle/index.js` is missing.
- `upgrade:local` expects a built `bundle/index.js` in the current repo.
- `verify:local` checks launcher/state and runs `get_status` + `search_docs` through MCP.
- Launcher runtime resolution (`MARTEN_MCP_RUNTIME=auto`) prefers `bun` first, then falls back to `node`.

## Path overrides

```bash
MARTEN_MCP_INSTALL_DIR=/custom/install/root
MARTEN_MCP_BIN_DIR=/custom/bin
MARTEN_MCP_CACHE_DIR=/custom/cache
MARTEN_MCP_RUNTIME=bun
```
