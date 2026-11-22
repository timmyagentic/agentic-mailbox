#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d "${TMPDIR:-/tmp}/agentic-mailbox-smoke.XXXXXX")
pid=
trap '
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
' EXIT

ditto -x -k "$1" "$scratch"
app="$scratch/Agentic Mailbox"
test -x "$app/runtime/node"
port=18787
origin="http://127.0.0.1:$port"
AGENTIC_MAILBOX_DATA_DIR="$scratch/data" AGENTIC_MAILBOX_LOCAL_PORT="$port" \
  AGENTIC_MAILBOX_NO_OPEN=1 "$app/打开本地邮箱.command" > "$scratch/launcher.log" 2>&1 &
pid=$!

for ((attempt = 0; attempt < 30; attempt++)); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  if grep -q '本地邮箱已启动' "$scratch/launcher.log"; then
    curl --noproxy '*' -fsS "$origin/api/session" | jq -e '.edition == "local"'
    curl --noproxy '*' -fsS "$origin/api/health" | jq -e '.ok and .dependencies.database == "ready"'
    exit 0
  fi
  sleep 1
done
cat "$scratch/launcher.log" >&2
exit 1
