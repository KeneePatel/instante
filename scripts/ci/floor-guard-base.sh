#!/usr/bin/env bash
# The floor guard as it stands at the merge base with origin/main, run on this change beside
# `pnpm floor-guard`, the change's own copy. A change can weaken scripts/floor-guard.ts, and its
# own copy would then pass it, but it can't weaken the copy main already has; a rule the change
# adds takes effect once it's merged. Run from the repository's root, with the whole history.
# Exit codes: the guard's (0 clean, 1 a floor violation, 2 it couldn't run); 2 when there's no
# merge base or no guard at it.
set -u -o pipefail

if ! base="$(git merge-base origin/main HEAD)"; then
  echo "floor-guard-base: no merge base with origin/main" >&2
  exit 2
fi
dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/floor-guard-base.XXXXXX")" || exit 2
trap 'rm -rf "$dir"' EXIT
if ! git show "$base:scripts/floor-guard.ts" >"$dir/floor-guard.ts"; then
  echo "floor-guard-base: no floor guard at $base" >&2
  exit 2
fi
echo "floor-guard-base: the guard at $base"
node "$dir/floor-guard.ts"
