#!/usr/bin/env sh
set -eu

REPO="${MARTEN_MCP_REPO:-stijnVanHorenbeek/marten_mcp}"
INSTALL_DIR="${MARTEN_MCP_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/marten-docs-mcp}"
BIN_DIR="${MARTEN_MCP_BIN_DIR:-${XDG_BIN_DIR:-$HOME/.local/bin}}"
CACHE_DIR="${MARTEN_MCP_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/marten-docs-mcp}"
SQLITE_PATH="${MARTEN_MCP_SQLITE_PATH:-$CACHE_DIR/cache.db}"
RUNTIME="${MARTEN_MCP_RUNTIME:-auto}"
STORAGE="${MARTEN_MCP_STORAGE_MODE:-auto}"
TAG="${MARTEN_MCP_VERSION:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar
require_cmd mktemp

if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p;q')
fi

if [ -z "$TAG" ]; then
  echo "Unable to determine release tag. Set MARTEN_MCP_VERSION=vX.Y.Z." >&2
  exit 1
fi

ARCHIVE_URL="https://github.com/$REPO/releases/download/$TAG/marten-docs-mcp-bundle-$TAG.tar.gz"
TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE_FILE="$TMP_DIR/bundle.tar.gz"
curl -fL "$ARCHIVE_URL" -o "$ARCHIVE_FILE"
tar -xzf "$ARCHIVE_FILE" -C "$TMP_DIR"

if [ ! -f "$TMP_DIR/bundle/index.js" ]; then
  echo "Invalid release artifact. Missing bundle/index.js" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$CACHE_DIR"
cp "$TMP_DIR/bundle/index.js" "$INSTALL_DIR/index.js"
chmod +x "$INSTALL_DIR/index.js"

LAUNCHER="$BIN_DIR/marten-docs-mcp"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env sh
set -eu

: "\${MARTEN_MCP_CACHE_DIR:=$CACHE_DIR}"
: "\${MARTEN_MCP_STORAGE_MODE:=$STORAGE}"
: "\${MARTEN_MCP_SQLITE_PATH:=$SQLITE_PATH}"

RUNTIME="\${MARTEN_MCP_RUNTIME:-$RUNTIME}"
if [ "\$RUNTIME" = "bun" ]; then
  exec bun "$INSTALL_DIR/index.js" "\$@"
fi
if [ "\$RUNTIME" = "node" ]; then
  exec node "$INSTALL_DIR/index.js" "\$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$INSTALL_DIR/index.js" "\$@"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun "$INSTALL_DIR/index.js" "\$@"
fi

echo "Neither node nor bun is available on PATH." >&2
exit 1
EOF
chmod +x "$LAUNCHER"

echo "Installed marten-docs-mcp $TAG at $LAUNCHER"
echo
cat <<EOF
{
  "mcpServers": {
    "marten-docs": {
      "command": "$LAUNCHER",
      "args": [],
      "env": {
        "MARTEN_MCP_CACHE_DIR": "$CACHE_DIR",
        "MARTEN_MCP_STORAGE_MODE": "$STORAGE",
        "MARTEN_MCP_SQLITE_PATH": "$SQLITE_PATH"
      }
    }
  }
}
EOF
