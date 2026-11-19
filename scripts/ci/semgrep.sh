#!/usr/bin/env bash
# Semgrep's registry rules over what this push or pull request adds (CONSTRAINTS.md, "Code
# security": no new ERROR findings), in the image SEMGREP_IMAGE names, pinned by digest in
# ci.yml. Run from the repository's root, with the whole history checked out.
#   - Only ERROR rules count (the owner's bar, 2026-11-19), and only findings that weren't
#     already at the base commit, which scripts/ci/scan-base.sh gives: Semgrep scans the changed
#     files there too, in a git worktree, and drops what it finds in both.
#   - --strict fails on a file Semgrep couldn't parse, which would otherwise pass unscanned.
#   - No login (p/default is public, fetched from semgrep.dev on each run), no metrics, no
#     version check.
#   - Semgrep's own default ignores leave out test/, tests/, node_modules/, build/ and dist/.
# It runs as the runner's own user, so git inside the image owns the checkout and nothing it
# writes is root's.
# Exit codes: Semgrep's (0 none, 1 new findings, 2 or more a failure), 2 no base commit.
set -u -o pipefail

image="${SEMGREP_IMAGE:?SEMGREP_IMAGE names the pinned image}"
base="$(bash "$(dirname "$0")/scan-base.sh")" || exit 2
echo "semgrep: new findings since $base"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e SEMGREP_ENABLE_VERSION_CHECK=0 \
  -v "$PWD:/src" -w /src "$image" \
  semgrep scan --config p/default --baseline-commit "$base" --severity ERROR --error --strict \
  --metrics=off
