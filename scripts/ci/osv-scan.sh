#!/usr/bin/env bash
# osv-scanner over the checkout, judged by scripts/check-osv.ts (CONSTRAINTS.md,
# "Dependencies": nothing at high or above). Both ci.yml and the weekly scan run this.
#
#   scripts/ci/osv-scan.sh <report.json>
#
# osv-scanner reads every lockfile under the checkout but those .gitignore leaves out, and asks
# OSV.dev about the packages in them; no token. Its exit 1 only means it found an advisory,
# which check-osv.ts then judges; any other failure is the scan's own.
# Exit codes: check-osv.ts's (0 nothing at high or above, 1 something), 2 the scan failed.
set -u -o pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/ci/osv-scan.sh <report.json>" >&2
  exit 2
fi
report="$1"
status=0
osv-scanner scan source -r --all-packages --format json --output-file "$report" . || status=$?
case "$status" in
  0 | 1) ;;
  *)
    echo "osv-scan: osv-scanner failed with exit $status" >&2
    exit 2
    ;;
esac
node scripts/check-osv.ts "$report"
