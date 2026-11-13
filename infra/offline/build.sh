#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
cd "$repo_root"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node 24 and pnpm install --frozen-lockfile are required. See infra/offline/README.md.' >&2
  exit 1
fi
exec node --import tsx "$script_dir/build.mts" "$@"
