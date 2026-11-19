#!/usr/bin/env bash
# Downloads a CI tool's release file and checks it against the SHA-256 pinned beside it in the
# workflow (docs/specs/platform.md: CI-only tools at pinned versions). HTTPS only, redirects
# included; a failed download is retried. A file that doesn't match is removed.
#
#   scripts/ci/fetch-checked.sh <url> <sha256> <file>
#
# Exit codes: 0 downloaded and matching, 1 the download failed or didn't match, 2 a usage error.
set -u -o pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: scripts/ci/fetch-checked.sh <url> <sha256> <file>" >&2
  exit 2
fi
url="$1"
expected="$2"
file="$3"
case "$expected" in
  *[!0-9a-f]*)
    echo "fetch-checked: '$expected' isn't a SHA-256 in lowercase hex" >&2
    exit 2
    ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo "fetch-checked: '$expected' isn't a SHA-256 in lowercase hex" >&2
  exit 2
fi
case "$url" in
  https://*) ;;
  *)
    echo "fetch-checked: $url isn't an https:// address" >&2
    exit 2
    ;;
esac

if ! curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --retry-all-errors \
  -o "$file" "$url"; then
  rm -f "$file"
  echo "fetch-checked: couldn't download $url" >&2
  exit 1
fi

# sha256sum on Linux, shasum on macOS.
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$file" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$file" | cut -d ' ' -f 1)"
fi
if [ "$actual" != "$expected" ]; then
  rm -f "$file"
  echo "fetch-checked: $url has SHA-256 $actual, not the pinned $expected" >&2
  exit 1
fi
echo "fetch-checked: $file matches its pinned SHA-256"
