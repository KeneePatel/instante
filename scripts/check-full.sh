#!/usr/bin/env bash
# `pnpm check:full` (docs/specs/platform.md, "Commands"): check:task, then ShellCheck over
# scripts/ and the end-to-end tests, as CI runs them. osv-scanner and Semgrep run only in CI (the
# owner's choice, 2026-11-20): neither is installed on the Mac, and CI runs Semgrep from its
# image. The end-to-end tests need Postgres with scripts/dev-db.sh run, Chromium's headless
# shell (`pnpm --filter @instante/web exec playwright install --only-shell chromium`), and ports
# 4320 and 4321 free.
# Exit codes: 0 every check passed, 1 one failed.
set -u -o pipefail

cd "$(dirname "$0")/.." || exit 1
pnpm check:task || exit 1
bash scripts/ci/shellcheck.sh || exit 1
pnpm test:e2e || exit 1
echo "check:full: every check passed; osv-scanner and Semgrep run only in CI"
