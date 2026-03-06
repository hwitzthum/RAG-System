#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf "[ok] %s: %s\n" "$cmd" "$("$cmd" --version 2>/dev/null | head -n 1 || echo available)"
  else
    printf "[missing] %s\n" "$cmd"
    return 1
  fi
}

echo "Running infrastructure preflight checks..."

status=0
check_cmd node || status=1
check_cmd npm || status=1
check_cmd vercel || status=1
check_cmd supabase || status=1
check_cmd psql || status=1

if [[ -f "$ROOT_DIR/.env.staging" ]]; then
  echo "Validating .env.staging values..."
  node "$ROOT_DIR/scripts/infrastructure/validate-env.mjs" --target staging --file "$ROOT_DIR/.env.staging" || status=1
else
  echo "[warn] .env.staging not found. Copy .env.staging.example to .env.staging before deployment checks."
fi

if [[ $status -ne 0 ]]; then
  echo "Preflight failed. Resolve missing tooling or env issues before provisioning."
  exit 1
fi

echo "Preflight passed."
