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
DATA_DIR="${POCKETBRIDGE_DATA_DIR:-$HOME/Library/Application Support/PocketBridge}"
PORT="${POCKETBRIDGE_PORT:-8787}"
if [[ -z "${POCKETBRIDGE_PORT:-}" && -f "$DATA_DIR/config.json" ]]; then
  PORT="$("$NODE" -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.port||8787))' "$DATA_DIR/config.json")"
fi
if ! /usr/bin/curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  /usr/bin/nohup "$NODE" "$MAC_DIR/scripts/run.mjs" >>"$DATA_DIR/service.log" 2>>"$DATA_DIR/service-error.log" </dev/null &
  for attempt in {1..30}; do
    if /usr/bin/curl --fail --silent --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null; then break; fi
    /bin/sleep 0.2
  done
fi
if ! /usr/bin/curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  print -u2 "PocketBridge could not start. See $DATA_DIR/service-error.log"
  exit 1
fi
/usr/bin/open "http://127.0.0.1:$PORT"
