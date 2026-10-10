#!/bin/zsh
set -euo pipefail
MAC_DIR="${0:A:h:h}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then NODE="$candidate"; break; fi
  done
fi
if [[ -z "$NODE" ]]; then print -u2 'Install Node.js 22 or newer first.'; exit 1; fi
exec "$NODE" "$MAC_DIR/scripts/setup-connection.mjs" "$@"
