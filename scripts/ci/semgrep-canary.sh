#!/usr/bin/env bash
# Semgrep's baseline, checked in the image SEMGREP_IMAGE names and run as scripts/ci/semgrep.sh
# runs it (the runner's user, HOME=/tmp, the repository mounted at /src), since semgrep.sh only
# reaches it once a change touches a file that already has an ERROR finding. In a scratch
# repository whose base commit already has a finding, a head commit that keeps it must pass,
# and one that adds another must fail. It brings a rule of its own, so it needs no registry and
# p/default can't change its result.
# Exit codes: 0 the baseline works, 1 it doesn't, 2 the check couldn't run.
set -u -o pipefail

image="${SEMGREP_IMAGE:?SEMGREP_IMAGE names the pinned image}"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/semgrep-canary.XXXXXX")" || exit 2
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
mkdir -p "$repo" "$work/rules" || exit 2
cat >"$work/rules/canary.yml" <<'EOF' || exit 2
rules:
  - id: canary-sink
    languages: [python]
    severity: ERROR
    message: a call to canary_sink
    pattern: canary_sink(...)
EOF

in_repo() {
  git -C "$repo" -c user.name=canary -c user.email=canary@example.test -c commit.gpgsign=false "$@"
}
in_repo init -q || exit 2
printf 'canary_sink(1)\n' >"$repo/a.py"
{ in_repo add a.py && in_repo commit -q -m 'a finding at the base'; } || exit 2
base="$(in_repo rev-parse HEAD)" || exit 2

# Semgrep's exit status, its output in $work/<name>.log.
scan() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e SEMGREP_ENABLE_VERSION_CHECK=0 \
    -v "$repo:/src" -v "$work/rules:/rules:ro" -w /src "$image" \
    semgrep scan --config /rules/canary.yml --baseline-commit "$base" --severity ERROR --error \
    --strict --metrics=off >"$work/$1.log" 2>&1
}

printf 'canary_sink(1)\nx = 2\n' >"$repo/a.py"
in_repo commit -q -am 'the finding kept' || exit 2
scan kept
kept=$?
printf 'canary_sink(1)\nx = 2\ncanary_sink(3)\n' >"$repo/a.py"
in_repo commit -q -am 'a finding added' || exit 2
scan added
added=$?

if [ "$kept" = 0 ] && [ "$added" = 1 ]; then
  echo "semgrep-canary: a finding at the base passes and a new one fails"
  exit 0
fi
echo "semgrep-canary: expected exit 0 with the base's finding kept and 1 with one added," \
  "got $kept and $added" >&2
for log in kept added; do
  echo "--- $log" >&2
  cat "$work/$log.log" >&2
done
if [ "$kept" -ge 2 ] || [ "$added" -ge 2 ]; then
  exit 2
fi
exit 1
