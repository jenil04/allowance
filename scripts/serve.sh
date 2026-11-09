#!/usr/bin/env bash
# Installs/builds if needed and starts Allowance on PORT 4320.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install
[ -f dist/index.html ] && [ -z "$(find src shared index.html vite.config.ts -newer dist/index.html -type f 2>/dev/null | head -1)" ] || npm run build
[ -f .env ] && { set -a; . ./.env; set +a; }
set -a
[ -f /workspace/secrets/cto-anthropic.env ] && . /workspace/secrets/cto-anthropic.env
[ -f /workspace/secrets/paypal-sandbox.env ] && . /workspace/secrets/paypal-sandbox.env
set +a
export PORT="${PORT:-4320}"
exec npx tsx server/index.ts
