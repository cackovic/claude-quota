#!/usr/bin/env bash
# Compatibility launcher for the canonical TypeScript CLI.

set -euo pipefail

script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
  script_dir="$(cd -P "$(dirname "$script_path")" >/dev/null 2>&1 && pwd)"
  link_target="$(readlink "$script_path")"
  [[ "$link_target" == /* ]] && script_path="$link_target" \
    || script_path="$script_dir/$link_target"
done
script_dir="$(cd -P "$(dirname "$script_path")" >/dev/null 2>&1 && pwd)"
tsx_bin="$script_dir/node_modules/.bin/tsx"

if [[ ! -x "$tsx_bin" ]]; then
  printf '%s\n' "Error: dependencies are not installed; run 'npm install' in $script_dir" >&2
  exit 1
fi

exec "$tsx_bin" "$script_dir/claude-quota.ts" "$@"
