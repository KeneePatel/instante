#!/usr/bin/env bash
# Installs the pinned osv-scanner into $RUNNER_TEMP/bin and puts that folder on the job's PATH.
# ci.yml and the weekly scan both use it, so the pin is here once. Linux x86-64 only: it's for
# GitHub's ubuntu runners.
set -u -o pipefail

# 2.7.0, released 2026-10-12, at least 14 days old. The SHA-256 is the release's own, from its
# osv-scanner_SHA256SUMS, for osv-scanner_linux_amd64.
version=2.7.0
sha256=160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b

bin="${RUNNER_TEMP:?needs RUNNER_TEMP, as GitHub runners set it}/bin"
mkdir -p "$bin" || exit 1
bash "$(dirname "$0")/fetch-checked.sh" \
  "https://github.com/google/osv-scanner/releases/download/v$version/osv-scanner_linux_amd64" \
  "$sha256" "$RUNNER_TEMP/osv-scanner" || exit 1
install -m 0755 "$RUNNER_TEMP/osv-scanner" "$bin/osv-scanner" || exit 1
echo "$bin" >>"${GITHUB_PATH:?needs GITHUB_PATH, as GitHub runners set it}"
"$bin/osv-scanner" --version
