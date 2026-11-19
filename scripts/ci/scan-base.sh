#!/usr/bin/env bash
# Prints the commit that a scan of this push or pull request starts from, for the scans that
# look only at what's new (gitleaks over git, Semgrep's baseline):
#   - on a push to main, the commit main was at before the push (github.event.before, passed
#     in as BEFORE), when it's a real commit this checkout holds;
#   - otherwise (a pull request, a branch push, a branch's first push), the merge base with
#     origin/main.
# It needs the whole history (checkout's fetch-depth: 0). When the base is HEAD itself there's
# nothing new to scan, and it says so on stderr.
# Exit codes: 0 the base printed, 2 no base could be found.
set -u -o pipefail

zero=0000000000000000000000000000000000000000
before="${BEFORE:-}"
if [ "${GITHUB_REF:-}" = refs/heads/main ] && [ -n "$before" ] && [ "$before" != "$zero" ] &&
  git cat-file -e "${before}^{commit}" 2>/dev/null; then
  base="$before"
elif ! base="$(git merge-base origin/main HEAD 2>/dev/null)"; then
  echo "scan-base: no merge base with origin/main: is the whole history fetched?" >&2
  exit 2
fi
if [ "$base" = "$(git rev-parse HEAD)" ]; then
  echo "scan-base: the base is HEAD, so there's nothing new to scan" >&2
fi
printf '%s\n' "$base"
