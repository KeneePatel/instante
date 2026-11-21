#!/usr/bin/env bash
# The stack the end-to-end tests run against (docs/specs/platform.md, "End-to-end tests"; T19),
# as Playwright's webServer starts it from apps/web/playwright.config.ts:
#   1. the web app built with its fixture pages (INSTANTE_E2E_PAGES=1, next.config.ts), which
#      reach the error screens the app ships no way into;
#   2. the database relay, the document service, the web app and the backend as `instante
#      start` starts them (scripts/prod-build/stack.sh), on ports 4320 and 4321 with
#      INSTANTE_ENV=test, the web app under its permission flags and, on macOS, its sandbox
#      profile. The backend comes last, so its /readyz, which Playwright waits on, answers only
#      once the web app does.
# It then runs until Playwright stops it (TERM), until one of them ends, or until the process
# that started it has gone (a runner killed, or its terminal closed, which runs none of
# Playwright's own teardown), and stops them all and removes its folder each way (procs.sh).
# Playwright's shell execs this script, so that process is the runner itself; the log names it.
#
# The checkout may hold apps/web/.env.local for `pnpm dev`, which `next build` and `next start`
# would apply for any name their environment lacks; __NEXT_PROCESSED_ENV, a private name of
# Next's, stops both (scripts/test/web-launch.test.ts shows it still does).
# Needs what scripts/prod-build-check.sh needs, less WRONG_NODE; it can't run beside it, since
# both use ports 4320 and 4321. Written for macOS's bash 3.2.
# Exit codes: 1 something didn't start or ended, 2 it couldn't run.
set -u -o pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 2
cd "$root" || exit 2
# shellcheck source=scripts/prod-build/stack.sh
. scripts/prod-build/stack.sh || exit 2

say() {
  echo "e2e-stack: $*"
}
stop() {
  echo "e2e-stack: $*" >&2
  exit 1
}

parent=$PPID
say "started by process $parent ($(ps -o comm= -p "$parent" 2>/dev/null))"
stack_node || exit 2
stack_ports || exit 2
work="$(mktemp -d "${TMPDIR:-/tmp}/ie2e.XXXXXX")" || exit 2
work="$(cd "$work" && pwd -P)" || exit 2
procs_setup "$work" || exit 2
stack_home test || exit 2

say "building the web app with its fixture pages"
if ! INSTANTE_E2E_PAGES=1 BACKEND_INTERNAL_URL="$backend_url" __NEXT_PROCESSED_ENV=true \
  NEXT_TELEMETRY_DISABLED=1 pnpm --filter @instante/web build >"$work/logs/build.log" 2>&1; then
  cat "$work/logs/build.log" >&2
  stop "the web build failed"
fi

stack_relay || stop "the database relay didn't start"
relay_pid=$last_pid
stack_documents || stop "the document service didn't start:$(stack_said documents)"
documents_pid=$last_pid
stack_web BACKEND_INTERNAL_URL="$backend_url" __NEXT_PROCESSED_ENV=true ||
  stop "the web app didn't start:$(stack_said web)"
stack_backend || stop "the backend didn't start:$(stack_said backend)"
backend_pid=$last_pid
say "ready: the web app at http://localhost:$web_port, the backend at $backend_url"

# Once the process that started it has gone, nothing reads its output (a write would end it on
# SIGPIPE), so it says nothing more and exits; the EXIT trap stops the rest.
while :; do
  for pid in "$relay_pid" "$documents_pid" "$web_pid" "$backend_pid"; do
    kill -0 "$pid" 2>/dev/null || break 2
  done
  if ! kill -0 "$parent" 2>/dev/null; then
    exec >/dev/null 2>&1
    exit 1
  fi
  sleep 1
done
for name in relay documents web backend; do
  echo "--- $name" >&2
  tail -n 20 "$work/logs/$name.log" >&2
done
stop "a process ended"
