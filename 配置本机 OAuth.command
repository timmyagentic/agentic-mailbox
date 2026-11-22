#!/bin/bash
set -e
cd "$(dirname "$0")"
if [[ -x ./runtime/node ]]; then exec ./runtime/node scripts/configure-local.mjs; fi
exec node scripts/configure-local.mjs
