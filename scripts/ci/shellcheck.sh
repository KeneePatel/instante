#!/usr/bin/env bash
# ShellCheck over every shell script in scripts/ (CONSTRAINTS.md, "Shell scripts"): each tracked
# file there ending in .sh, or whose first line starts it with bash or sh, as the launcher in
# scripts/local/ will, with no extension. Run from the repository's root. CI installs the
# pinned ShellCheck; on the Mac it's Homebrew's.
# Exit codes: ShellCheck's own (0 no findings, 1 findings), 2 no script found or no ShellCheck.
set -u -o pipefail

if ! command -v shellcheck >/dev/null; then
  echo "shellcheck.sh: shellcheck isn't on PATH" >&2
  exit 2
fi

files=()
while IFS= read -r -d '' file; do
  case "$file" in
    *.sh)
      files+=("$file")
      continue
      ;;
  esac
  first=''
  IFS= read -r first <"$file" || true
  case "$first" in
    '#!'*bash* | '#!'*/sh | '#!'*' sh' | '#!'*/sh' '*) files+=("$file") ;;
  esac
done < <(git ls-files -z -- scripts)

if [ "${#files[@]}" -eq 0 ]; then
  echo "shellcheck.sh: no shell script under scripts/" >&2
  exit 2
fi
shellcheck --version | sed -n 's/^version: /shellcheck.sh: ShellCheck /p'
printf 'shellcheck.sh: checking %s\n' "${files[@]}"
shellcheck -- "${files[@]}"
