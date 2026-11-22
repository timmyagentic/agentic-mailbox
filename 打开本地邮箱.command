#!/bin/bash
set -e
cd "$(dirname "$0")"
if [[ -x ./runtime/node ]]; then exec ./runtime/node scripts/local.mjs; fi
if ! command -v npm >/dev/null; then echo '源码版需要 Node.js 22.12 或以上。也可以使用内置 Node 的 Mac 离线包。'; read -r; exit 1; fi
[[ -d node_modules ]] || npm ci
exec npm start
