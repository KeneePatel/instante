#!/usr/bin/env bash
# The production build's checks (docs/specs/platform.md, criterion 7, apart from what the web
# app's launch flags deny, which scripts/test/web-launch.test.ts checks), in a scratch home, in
# production mode:
#   1. src/ imports nothing from test/: the backend's import graph, as TypeScript follows it,
#      and the web build's own sources, as its server source maps list them;
#   2. the web app builds, with no static page;
#   3. the production guard refuses each case, each one change away from settings it accepts;
#   4. the web build stops when started with another BACKEND_INTERNAL_URL, or none, even with
#      INSTANTE_BUILT_BACKEND in its environment, since the build's address is fixed into it;
#      and without NEXT_PRIVATE_OUTPUT_TRACE_ROOT, which keeps Next inside its read grant;
#   5. the document service, the backend and the web app start as `instante start` starts them
#      (scripts/prod-build/stack.sh, the web app under its sandbox profile on macOS): /readyz
#      answers, /api reaches the backend through the rewrite, no test route and no end-to-end
#      fixture page is served, the page's policy is production's, and selftest passes.
#
# Needs: the Node mise.toml pins on PATH, pnpm, the workspace installed, a Postgres 18 on
# 127.0.0.1:5432 with scripts/dev-db.sh run (instante_test migrated), ports 4320 and 4321 free,
# and WRONG_NODE, the path of a Node other than the pinned one (CI downloads one; a run outside
# CI without it skips that case and says so). Its home is a fresh mktemp folder, never
# ~/.instante. The database's socket there is scripts/prod-build/pg-relay.ts, a relay to
# 127.0.0.1:5432, since production connects only through $INSTANTE_HOME/run. It writes
# apps/web/.next, so run it from a checkout with no apps/web/.env* file (next start would read
# one), such as CI's or a scratch worktree. Written for macOS's bash 3.2.
# Exit codes: 0 every check passed, 1 a check failed, 2 it couldn't run.
set -u -o pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 2
cd "$root" || exit 2
# The stack as `instante start` starts it (ports, the pinned Node, the home, the web command),
# and procs.sh's start, run_for and ended_as: each process in a group of its own, stopped whole.
# shellcheck source=scripts/prod-build/stack.sh
. scripts/prod-build/stack.sh || exit 2

other_url=http://127.0.0.1:4399

die() {
  echo "prod-build-check: $*" >&2
  exit 2
}
failures=0
skipped=0
pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*" >&2
  failures=$((failures + 1))
}
skip() {
  echo "skip  $*"
  skipped=$((skipped + 1))
}

# next start reads apps/web's env files for every name its environment lacks, which would
# change the start-up cases below, and isn't how a release starts.
for f in apps/web/.env apps/web/.env.local apps/web/.env.production apps/web/.env.production.local; do
  [ -e "$f" ] && die "$f exists, and next start would read it: run this from a clean checkout"
done

stack_node || exit 2
pinned="$("$node" --version)"
wrong_node="${WRONG_NODE:-}"
if [ -z "$wrong_node" ]; then
  [ "${CI:-}" = true ] && die "WRONG_NODE must name a Node other than the pinned one in CI"
elif [ ! -x "$wrong_node" ] || [ "$("$wrong_node" --version)" = "$pinned" ]; then
  die "WRONG_NODE must name a Node other than the pinned one, not $wrong_node"
fi

stack_ports || exit 2

# The scratch folder: tools/ for this script's files, logs/, and home/ as INSTANTE_HOME, short,
# since a socket's path is capped. From procs_setup on, every exit stops what the check started
# and removes the folder (procs.sh).
work="$(mktemp -d "${TMPDIR:-/tmp}/ipb.XXXXXX")" || die "can't make a scratch folder"
work="$(cd "$work" && pwd -P)" || die "can't enter $work"
procs_setup "$work" || die "can't set up $work"
stack_home production || exit 2
(umask 077 && mkdir -p "$work/tools") || exit 2

# 1a. The backend runs its source: every file its entry points reach, by any import TypeScript
# follows (static, type-only, or import() of a literal), must be outside test/. A specifier
# built at run time isn't followed.
cat >"$work/tools/tsconfig.json" <<EOF || exit 2
{
  "extends": "$root/apps/backend/tsconfig.json",
  "compilerOptions": { "typeRoots": ["$root/apps/backend/node_modules/@types"] },
  "files": ["$root/apps/backend/src/main.ts"],
  "include": ["$root/apps/backend/src/documents/tasks/*.ts"],
  "exclude": ["$root/apps/backend/src/**/*.test.ts"]
}
EOF
if ! graph="$(pnpm exec tsc -p "$work/tools/tsconfig.json" --listFilesOnly)"; then
  fail "tsc couldn't list the backend's import graph"
elif ! printf '%s\n' "$graph" | grep -qxF "$root/apps/backend/src/main.ts"; then
  fail "the backend's import graph doesn't hold src/main.ts"
elif from_test="$(printf '%s\n' "$graph" | grep -F "$root/" | grep -v '/node_modules/' |
  cut -c "$((${#root} + 2))-" | grep -E '(^|/)(test|e2e)/')"; then
  fail "the backend's source reaches test/: $from_test"
else
  pass "the backend's source imports nothing from test/"
fi

# 2. The build, with the backend's address fixed into it.
if ! BACKEND_INTERNAL_URL="$backend_url" NEXT_TELEMETRY_DISABLED=1 \
  pnpm --filter @instante/web build >"$work/logs/build.log" 2>&1; then
  cat "$work/logs/build.log" >&2
  echo "prod-build-check: the web build failed" >&2
  exit 1
fi
pass "the web app builds, with BACKEND_INTERNAL_URL=$backend_url"
if node scripts/check-no-static.ts; then pass "no static page"; else fail "the build has a static page"; fi

# 1b. The web build's own sources.
if node scripts/prod-build/web-sources.ts "$root"; then
  pass "the web build holds nothing from a test folder"
else
  fail "the web build's sources"
fi

# 3. The guard. Each case is one change from the settings the stack starts with in step 5, and
# must exit 78 naming that problem alone: a schema problem stops the guard before its production
# checks, so a looser match could pass for the wrong reason. A case the guard wrongly accepted
# would start, and be stopped, with whatever it started, at its 20-second deadline. Each case's
# output goes to a file, not $(...), which would wait for every process holding it open.
main="$root/apps/backend/src/main.ts"

refuses() {
  local expected="$1" out status
  shift
  run_for 20 "$@" >/dev/null 2>"$work/logs/case.log"
  status=$?
  out="$(cat "$work/logs/case.log")"
  if [ "$status" = 78 ] && [ "$(printf '%s\n' "$out" | sed -n 's/^- //p')" = "$expected" ]; then
    pass "refused: $expected"
  else
    fail "expected exit 78 and only \"$expected\", got $(ended_as "$status"): $out"
  fi
}
url_file() {
  (umask 077 && printf '%s\n' "$2" >"$work/tools/$1.url") || exit 2
  echo "$work/tools/$1.url"
}
off_socket="DATABASE_URL_FILE: production connects only through the socket folder $home/run"
refuses "$off_socket" env -i "${backend_env[@]}" \
  DATABASE_URL_FILE="$(url_file tcp 'postgresql://instante_app@127.0.0.1:5432/instante_test')" \
  "$node" --disable-sigusr1 "$main"
refuses "$off_socket" env -i "${backend_env[@]}" \
  DATABASE_URL_FILE="$(url_file elsewhere 'postgresql://instante_app@/instante_test?host=/tmp')" \
  "$node" --disable-sigusr1 "$main"
for address in 0.0.0.0 :: 192.0.2.1; do
  refuses "LISTEN_ADDRESS must be 127.0.0.1: the backend listens on loopback only" \
    env -i "${backend_env[@]}" LISTEN_ADDRESS="$address" "$node" --disable-sigusr1 "$main"
done
if [ -n "$wrong_node" ]; then
  refuses "production runs only on Node $pinned" \
    env -i "${backend_env[@]}" "$wrong_node" --disable-sigusr1 "$main"
  refuses "production runs only on Node $pinned" \
    env -i "${documents_env[@]}" "$wrong_node" --disable-sigusr1 "$main"
else
  skip "the wrong Node: WRONG_NODE isn't set (CI sets it)"
fi
for port in 4310 4311; do
  refuses "PORT $port is reserved for real use" \
    env -i "${backend_env[@]}" PORT="$port" "$node" --disable-sigusr1 "$main"
done
refuses "ALLOWED_HOST names a host or port reserved for real use" \
  env -i "${backend_env[@]}" ALLOWED_HOST=instante.localhost:4310 "$node" --disable-sigusr1 "$main"
refuses "production processes start with --disable-sigusr1" \
  env -i "${backend_env[@]}" "$node" "$main"
refuses "production processes start with no inspector flags" \
  env -i "${backend_env[@]}" "$node" --disable-sigusr1 --inspect-port=0 "$main"
refuses "NODE_OPTIONS must not be set in production" \
  env -i "${backend_env[@]}" NODE_OPTIONS=--no-warnings "$node" --disable-sigusr1 "$main"
refuses "DOCUMENTS_SOCKET must be in $home/run in production" \
  env -i "${documents_env[@]}" DOCUMENTS_SOCKET="$work/documents.sock" \
  "$node" --disable-sigusr1 "$main"

# 4. The web app, as `instante start` starts it (stack.sh's web), with the read grant on this
# checkout.
# With INSTANTE_BUILT_BACKEND set to the address it's started with, a build that read the
# address at run time would start; set in the `unset` case, the message would name 4399.
mismatch() {
  local now="$1" out status
  shift
  run_for 60 web "$@" >"$work/logs/case.log" 2>&1
  status=$?
  out="$(cat "$work/logs/case.log")"
  if [ "$status" = 1 ] && printf '%s\n' "$out" | grep -qxF \
    "This build sends /api to $backend_url, but BACKEND_INTERNAL_URL is $now: build again with it, or set it back."; then
    pass "built for $backend_url, the web app stops with BACKEND_INTERNAL_URL $now ($*)"
  else
    fail "the web app with BACKEND_INTERNAL_URL $now ($*): $(ended_as "$status"): $out"
  fi
}
mismatch "$other_url" BACKEND_INTERNAL_URL="$other_url"
mismatch "$other_url" BACKEND_INTERNAL_URL="$other_url" INSTANTE_BUILT_BACKEND="$other_url"
mismatch unset
mismatch unset INSTANTE_BUILT_BACKEND="$other_url"

# The root variable is private to Next.js (platform spec, the web command): without it, Next
# looks for a workspace root above the checkout, which the read grant refuses. This shows why the
# launch sets it; a Next.js that stopped reading it would fail the cases above, which set it and
# would stop on that refusal before their own message.
run_for 60 web BACKEND_INTERNAL_URL="$backend_url" NEXT_PRIVATE_OUTPUT_TRACE_ROOT= \
  >"$work/logs/case.log" 2>&1
status=$?
if [ "$status" != 0 ] && [ "$status" != 124 ] && grep -q ERR_ACCESS_DENIED "$work/logs/case.log"; then
  pass "without NEXT_PRIVATE_OUTPUT_TRACE_ROOT, the web app's start reads past its grant and stops"
else
  fail "without NEXT_PRIVATE_OUTPUT_TRACE_ROOT: $(ended_as "$status"): $(tail -n 20 "$work/logs/case.log")"
fi

# 5. The stack.
stack_relay || die "the database relay didn't start"
stack_documents || fail "the document service didn't start:$(stack_said documents)"
if stack_backend; then
  pass "the backend starts in production, and /readyz answers"
else
  fail "/readyz: $(curl -s --max-time 6 "$backend_url/readyz")$(stack_said backend)"
fi
if stack_web BACKEND_INTERNAL_URL="$backend_url"; then
  pass "the web app starts with its own BACKEND_INTERNAL_URL"
else
  fail "the web app didn't start:$(stack_said web)"
fi
page() { stack_page "$@"; }
if page -D - -o /dev/null "http://127.0.0.1:$web_port/api/ping" | tr -d '\r' |
  grep -qix 'cache-control: private, no-store'; then
  pass "/api reaches the backend through the rewrite"
else
  fail "/api/ping through the rewrite"
fi
# Criterion 4 on the build: production doesn't register the test routes.
pdf="$(page -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web_port/api/test/file.pdf")"
case "$pdf" in
  401 | 404) pass "production serves no test route ($pdf for /api/test/file.pdf)" ;;
  *) fail "/api/test/file.pdf answered $pdf in production" ;;
esac
# The end-to-end build's fixture pages (next.config.ts) aren't pages in this build.
fixture="$(page -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web_port/e2e/shell-error")"
if [ "$fixture" = 404 ]; then
  pass "this build serves no end-to-end fixture page"
else
  fail "/e2e/shell-error, an end-to-end fixture page, answered $fixture"
fi
policy="$(page -o /dev/null -D - "http://127.0.0.1:$web_port/" | tr -d '\r' |
  sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: //p')"
case "; $policy;" in
  *unsafe-eval* | *"; style-src 'self' 'unsafe-inline';"*) fail "a development policy: $policy" ;;
  *"; style-src 'self' 'nonce-"*) pass "the page's policy is production's" ;;
  *) fail "no policy like production's: $policy" ;;
esac

if "$node" --disable-sigusr1 scripts/prod-build/selftest.ts "$socket" "$backend_port" \
  "$db_socket" "$home/secrets"; then
  pass "selftest"
else
  fail "selftest"
fi

if [ "$failures" -gt 0 ]; then
  for log in "$work"/logs/*.log; do
    echo "--- $log" >&2
    tail -n 50 "$log" >&2
  done
  echo "prod-build-check: $failures failed" >&2
  exit 1
fi
if [ "$skipped" -gt 0 ]; then
  echo "prod-build-check: every check passed, but $skipped skipped"
else
  echo "prod-build-check: every check passed"
fi
