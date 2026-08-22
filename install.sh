#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

command -v bun >/dev/null 2>&1 || {
  echo "piew requires Bun: https://bun.sh" >&2
  exit 1
}

bun install --frozen-lockfile
bun run build
bun link

echo "Installed piew."
