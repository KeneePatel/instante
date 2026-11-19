#!/usr/bin/env bash
# The production build's checks (docs/specs/platform.md, criterion 7, apart from the web app's
# launch flags, which T19 checks), in a scratch home, in production mode:
#   1. src/ imports nothing from test/: the backend's import graph, as TypeScript follows it,
#      and the web build's own sources, as its server source maps list them;
#   2. the web app builds, with no static page;
#   3. the production guard refuses each case, each one change away from settings it accepts;
#   4. the web build stops when started with another BACKEND_INTERNAL_URL, or none, even with
#      INSTANTE_BUILT_BACKEND in its environment, since the build's address is fixed into it;
#   5. the document service, the backend and the web app start as `instante start` starts them:
#      /readyz answers, /api reaches the backend through the rewrite, no test route is served,
#      the page's policy is production's, and selftest passes.
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

web_port=4320
backend_port=4321
other_url=http://127.0.0.1:4399
allowed_host="localhost:$web_port"
backend_url="http://127.0.0.1:$backend_port"

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

# The pinned Node, by its real path, as scripts/dev.sh finds it.
pinned="$(sed -n 's/^node = "\([0-9.]*\)"$/\1/p' mise.toml)"
if ! node="$(command -v node)" || ! node="$("$node" -p process.execPath)"; then
  die "node isn't on PATH"
fi
if [ -z "$pinned" ] || [ "$("$node" --version)" != "v$pinned" ]; then
  die "$node isn't Node $pinned, which mise.toml pins"
fi
wrong_node="${WRONG_NODE:-}"
if [ -z "$wrong_node" ]; then
  [ "${CI:-}" = true ] && die "WRONG_NODE must name a Node other than the pinned one in CI"
elif [ ! -x "$wrong_node" ] || [ "$("$wrong_node" --version)" = "v$pinned" ]; then
  die "WRONG_NODE must name a Node other than the pinned one, not $wrong_node"
fi

lsof=''
for candidate in /usr/sbin/lsof /usr/bin/lsof; do
  if [ -x "$candidate" ]; then
    lsof="$candidate"
    break
  fi
done
[ -n "$lsof" ] || die "lsof isn't at /usr/sbin/lsof or /usr/bin/lsof"
for port in "$web_port" "$backend_port"; do
  [ -z "$("$lsof" -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null)" ] || die "port $port is in use"
done

# The scratch folder: tools/ for this script's files, logs/, and home/ as INSTANTE_HOME. Short,
# since a socket's path is capped (104 bytes for Node's, 103 for Postgres's).
work="$(mktemp -d "${TMPDIR:-/tmp}/ipb.XXXXXX")" || die "can't make a scratch folder"
work="$(cd "$work" && pwd -P)" || die "can't enter $work"
home="$work/home"
socket="$home/run/documents.sock"
db_socket="$home/run/.s.PGSQL.5432"
if [ "${#db_socket}" -gt 103 ]; then
  rm -rf "$work"
  die "$db_socket is too long for a socket: set a shorter TMPDIR"
fi

groups="$work/groups"
stopping=0
# Stops each process group started below: TERM, then KILL to any left after 15 seconds.
end_groups() {
  local group name tries=75 left
  [ -f "$groups" ] || return 0
  while read -r group name; do
    kill -TERM -- "-$group" 2>/dev/null
  done <"$groups"
  while [ "$tries" -gt 0 ]; do
    left=0
    while read -r group name; do
      kill -0 -- "-$group" 2>/dev/null && left=1
    done <"$groups"
    [ "$left" = 0 ] && return 0
    sleep 0.2
    tries=$((tries - 1))
  done
  while read -r group name; do
    if kill -0 -- "-$group" 2>/dev/null; then
      echo "prod-build-check: $name didn't stop in 15 seconds; killing it" >&2
      kill -KILL -- "-$group" 2>/dev/null
    fi
  done <"$groups"
}
cleanup() {
  [ "$stopping" = 1 ] && return 0
  stopping=1
  trap '' INT TERM HUP
  end_groups
  rm -rf "$work"
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

(umask 077 && mkdir -p "$work/tools" "$work/logs" "$home/run" "$home/secrets") || exit 2
(umask 077 && printf 'postgresql://instante_app@/instante_test?host=%s\n' "$home/run" \
  >"$home/secrets/app.url") || exit 2

# Starts the command after the name in a process group of its own, its output in
# logs/<name>.log; its pid is then in $last_pid.
last_pid=''
start() {
  local name="$1"
  shift
  set -m
  "$@" </dev/null >"$work/logs/$name.log" 2>&1 &
  last_pid=$!
  set +m
  echo "$last_pid $name" >>"$groups"
}

# Runs the command to its end, or kills it after $1 seconds and returns 124: bash 3.2 has no
# `timeout`.
run_for() {
  local deadline=$((SECONDS + $1)) pid
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.2
  done
  wait "$pid"
}

# Waits up to $2 seconds for the command after them to succeed, while process $1 runs.
await() {
  local pid="$1" deadline=$((SECONDS + $2))
  shift 2
  while [ "$SECONDS" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || return 1
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

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
# would start, and be killed at its 20-second deadline.
backend_env=(INSTANTE_ENV=production ROLE=all INSTANTE_HOME="$home" LISTEN_ADDRESS=127.0.0.1
  PORT="$backend_port" ALLOWED_HOST="$allowed_host" DATABASE_URL_FILE="$home/secrets/app.url"
  DOCUMENTS_SOCKET="$socket")
documents_env=(INSTANTE_ENV=production ROLE=documents INSTANTE_HOME="$home"
  DOCUMENTS_SOCKET="$socket")
main="$root/apps/backend/src/main.ts"

refuses() {
  local expected="$1" out status
  shift
  out="$(run_for 20 "$@" 2>&1 >/dev/null)"
  status=$?
  if [ "$status" = 78 ] && [ "$(printf '%s\n' "$out" | sed -n 's/^- //p')" = "$expected" ]; then
    pass "refused: $expected"
  else
    fail "expected exit 78 and only \"$expected\", got $status: $out"
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
  refuses "production runs only on Node v$pinned" \
    env -i "${backend_env[@]}" "$wrong_node" --disable-sigusr1 "$main"
  refuses "production runs only on Node v$pinned" \
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

# 4. The web app, as `instante start` starts it (docs/specs/platform.md), with the read grant
# on this checkout; T19 checks what the grant denies. It starts in apps/web, since Next resolves
# next.config.ts's imports from its working folder.
web() {
  (cd "$root/apps/web" && exec env -i NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PRIVATE_OUTPUT_TRACE_ROOT="$root" ALLOWED_HOST="$allowed_host" "$@" \
    "$node" --disable-sigusr1 --permission --allow-fs-read="$root" --allow-net \
    --no-experimental-sqlite --freeze-flags-after-init \
    "$root/apps/web/node_modules/next/dist/bin/next" start \
    --experimental-next-config-strip-types -H 127.0.0.1 -p "$web_port")
}
# With INSTANTE_BUILT_BACKEND set to the address it's started with, a build that read the
# address at run time would start; set in the `unset` case, the message would name 4399.
mismatch() {
  local now="$1" out status
  shift
  out="$(run_for 60 web "$@" 2>&1)"
  status=$?
  if [ "$status" = 1 ] && printf '%s\n' "$out" | grep -qxF \
    "This build sends /api to $backend_url, but BACKEND_INTERNAL_URL is $now: build again with it, or set it back."; then
    pass "built for $backend_url, the web app stops with BACKEND_INTERNAL_URL $now ($*)"
  else
    fail "the web app with BACKEND_INTERNAL_URL $now ($*): exit $status: $out"
  fi
}
mismatch "$other_url" BACKEND_INTERNAL_URL="$other_url"
mismatch "$other_url" BACKEND_INTERNAL_URL="$other_url" INSTANTE_BUILT_BACKEND="$other_url"
mismatch unset
mismatch unset INSTANTE_BUILT_BACKEND="$other_url"

# 5. The stack.
start relay "$node" --disable-sigusr1 scripts/prod-build/pg-relay.ts "$db_socket"
await "$last_pid" 10 test -S "$db_socket" || die "the database relay didn't start"

start documents env -i "${documents_env[@]}" "$node" --disable-sigusr1 "$main"
documents_pid=$last_pid
await "$documents_pid" 30 curl -s -o /dev/null --max-time 2 --unix-socket "$socket" http://documents/ ||
  fail "the document service didn't start"

start backend env -i "${backend_env[@]}" "$node" --disable-sigusr1 "$main"
backend_pid=$last_pid
if await "$backend_pid" 60 curl -fs -o /dev/null --max-time 6 "$backend_url/readyz"; then
  pass "the backend starts in production, and /readyz answers"
else
  fail "/readyz: $(curl -s --max-time 6 "$backend_url/readyz")"
fi

start web web BACKEND_INTERNAL_URL="$backend_url"
web_pid=$last_pid
page() { curl -s --max-time 10 -H "Host: $allowed_host" "$@"; }
web_ready() { [ "$(page -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web_port/")" = 200 ]; }
if await "$web_pid" 60 web_ready; then
  pass "the web app starts with its own BACKEND_INTERNAL_URL"
else
  fail "the web app didn't start"
fi
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
