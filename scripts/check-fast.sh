#!/usr/bin/env bash
# check:fast: Prettier and untyped ESLint on the files this change touches, so it
# stays under 5 seconds after an edit. Written for macOS's bash 3.2.
set -u -o pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

files=()
while IFS= read -r f; do
  [ -f "$f" ] && files+=("$f")
done < <({
  git diff --name-only --diff-filter=ACMR HEAD
  git ls-files --others --exclude-standard
} | sort -u)

if [ "${#files[@]}" -eq 0 ]; then
  echo "check:fast: nothing changed"
  exit 0
fi

status=0
pnpm exec prettier --check --ignore-unknown "${files[@]}" || status=1

lintable=()
for f in "${files[@]}"; do
  case "$f" in
    *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) lintable+=("$f") ;;
  esac
done
if [ "${#lintable[@]}" -gt 0 ]; then
  pnpm exec eslint -c eslint.fast.config.mjs --max-warnings 0 --no-warn-ignored "${lintable[@]}" || status=1
fi

exit "$status"
