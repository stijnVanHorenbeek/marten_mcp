#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$#" -lt 1 ]; then
  echo "Usage: ./scripts/lifecycle.sh <install|verify|upgrade|uninstall> [args...]" >&2
  exit 1
fi

CMD="$1"
shift

case "$CMD" in
  install|verify|upgrade|uninstall)
    ;;
  *)
    echo "Unknown lifecycle command: $CMD" >&2
    echo "Expected one of: install, verify, upgrade, uninstall" >&2
    exit 1
    ;;
esac

if command -v bun >/dev/null 2>&1; then
  exec bun run "$SCRIPT_DIR/$CMD.ts" "$@"
fi

echo "bun is required to run scripts/$CMD.ts" >&2
exit 1
