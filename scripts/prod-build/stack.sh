# shellcheck shell=bash
# The stack as `instante start` starts it (docs/specs/platform.md, `instante start`): the
# document service on its socket, the backend on loopback and the web app, each from `env -i`
# with its own names, the pinned Node by its real path and --disable-sigusr1; the web app under
# its permission flags and, on macOS, the sandbox profile scripts/prod-build/web.sb. Sourced
# after procs.sh by scripts/prod-build-check.sh and scripts/e2e-stack.sh; T22's launcher starts
# the same commands. Written for macOS's bash 3.2, under `set -u`.
#
# It sources procs.sh, and its checkout, by its real path, is $stack_root: the web app's whole
# read grant. A caller sources this file alone, then calls, in this order:
#   stack_node                  the pinned Node, in $node;
#   stack_ports                 refuses a port already listened on;
#   procs_setup <folder>        (procs.sh) the folder, its traps and its watchdog;
#   stack_home <mode>           a home in that folder for INSTANTE_ENV=<mode>, production or
#                               test, with backend_env and documents_env;
# then starts what it needs with stack_relay, stack_documents, stack_backend and stack_web,
# each 0 once it answers and 1 if it didn't (stack_said names why). `web` is the web app's
# launch command alone, for a case that runs it to its end.

stack_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)" || return 2
# shellcheck source=scripts/prod-build/procs.sh
. "$stack_root/scripts/prod-build/procs.sh" || return 2

web_port=4320
backend_port=4321
allowed_host="localhost:$web_port"
backend_url="http://127.0.0.1:$backend_port"
node=''
home=''
socket=''
db_socket=''
backend_env=()
documents_env=()
web_pid=''

stack_error() {
  echo "stack: $*" >&2
}

# The Node mise.toml pins, by its real path, as scripts/dev.sh finds it.
stack_node() {
  local pinned
  pinned="$(sed -n 's/^node = "\([0-9.]*\)"$/\1/p' "$stack_root/mise.toml")"
  if ! node="$(command -v node)" || ! node="$("$node" -p process.execPath)"; then
    stack_error "node isn't on PATH"
    return 2
  fi
  if [ -z "$pinned" ] || [ "$("$node" --version)" != "v$pinned" ]; then
    stack_error "$node isn't Node $pinned, which mise.toml pins"
    return 2
  fi
}

stack_lsof() {
  local candidate
  for candidate in /usr/sbin/lsof /usr/bin/lsof; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  stack_error "lsof isn't at /usr/sbin/lsof or /usr/bin/lsof"
  return 2
}

stack_ports() {
  local lsof port
  lsof="$(stack_lsof)" || return 2
  for port in "$web_port" "$backend_port"; do
    if [ -n "$("$lsof" -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null)" ]; then
      stack_error "port $port is in use"
      return 2
    fi
  done
}

# The home: run/ for the sockets (a socket's path is capped: 104 bytes for Node's, 103 for
# Postgres's) and secrets/app.url, the database through the home's socket, as production
# connects. The database socket is scripts/prod-build/pg-relay.ts's, relaying to the
# Postgres on 127.0.0.1:5432 with scripts/dev-db.sh run.
stack_home() {
  local mode="$1"
  home="$procs_dir/home"
  socket="$home/run/documents.sock"
  db_socket="$home/run/.s.PGSQL.5432"
  if [ "${#db_socket}" -gt 103 ]; then
    stack_error "$db_socket is too long for a socket: set a shorter TMPDIR"
    return 2
  fi
  (umask 077 && mkdir -p "$home/run" "$home/secrets") || return 2
  (umask 077 && printf 'postgresql://instante_app@/instante_test?host=%s\n' "$home/run" \
    >"$home/secrets/app.url") || return 2
  backend_env=(INSTANTE_ENV="$mode" ROLE=all INSTANTE_HOME="$home" LISTEN_ADDRESS=127.0.0.1
    PORT="$backend_port" ALLOWED_HOST="$allowed_host" DATABASE_URL_FILE="$home/secrets/app.url"
    DOCUMENTS_SOCKET="$socket")
  documents_env=(INSTANTE_ENV="$mode" ROLE=documents INSTANTE_HOME="$home"
    DOCUMENTS_SOCKET="$socket")
}

# The end of a started process's log, for a failure's message: cleanup removes logs/.
stack_said() {
  printf '\n%s' "$(tail -n 20 "$procs_dir/logs/$1.log" 2>/dev/null)"
}

# Waits up to $2 seconds for the command after them to succeed, while process $1 runs.
stack_await() {
  local pid="$1" deadline=$((SECONDS + $2))
  shift 2
  while [ "$SECONDS" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || return 1
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# A page from the web app, with the Host it answers to.
stack_page() {
  curl -s --max-time 10 -H "Host: $allowed_host" "$@"
}
stack_web_ready() {
  [ "$(stack_page -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web_port/")" = 200 ]
}

# The web app's launch command, as `instante start` runs it, with the names after it added to
# its environment. It starts in apps/web, since Next resolves next.config.ts's imports from its
# working folder. On macOS it runs under the sandbox profile, which allows reads only inside
# the checkout, judged by where the kernel lands; its output must be a pipe, /dev/null or a file
# under the logs folder the profile is given, or Node aborts at start (exit 134).
# STACK_WEB_MAIN, when set, runs that script in Next's place, under the same flags and profile
# (the planted-secret probe).
web() {
  local main="${STACK_WEB_MAIN:-$stack_root/apps/web/node_modules/next/dist/bin/next}"
  local profile=()
  if [ "$(uname -s)" = Darwin ]; then
    profile=(/usr/bin/sandbox-exec -f "$stack_root/scripts/prod-build/web.sb" -D RELEASE="$stack_root"
      -D NODE="$node" -D WEB_PORT="$web_port" -D BACKEND_PORT="$backend_port"
      -D LOGS="$procs_dir/logs")
  fi
  local start=()
  [ -n "${STACK_WEB_MAIN:-}" ] || start=(start --experimental-next-config-strip-types -H 127.0.0.1
    -p "$web_port")
  (cd "$stack_root/apps/web" && exec env -i NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PRIVATE_OUTPUT_TRACE_ROOT="$stack_root" ALLOWED_HOST="$allowed_host" "$@" \
    ${profile[@]+"${profile[@]}"} \
    "$node" --disable-sigusr1 --permission --allow-fs-read="$stack_root" --allow-net \
    --no-experimental-sqlite --freeze-flags-after-init "$main" ${start[@]+"${start[@]}"})
}

stack_relay() {
  start relay "$node" --disable-sigusr1 "$stack_root/scripts/prod-build/pg-relay.ts" "$db_socket"
  stack_await "$last_pid" 10 test -S "$db_socket"
}

stack_documents() {
  start documents env -i "${documents_env[@]}" "$node" --disable-sigusr1 \
    "$stack_root/apps/backend/src/main.ts"
  stack_await "$last_pid" 30 \
    curl -s -o /dev/null --max-time 2 --unix-socket "$socket" http://documents/
}

stack_backend() {
  start backend env -i "${backend_env[@]}" "$node" --disable-sigusr1 \
    "$stack_root/apps/backend/src/main.ts"
  stack_await "$last_pid" 60 curl -fs -o /dev/null --max-time 6 "$backend_url/readyz"
}

# The web app, with the names given added to its environment.
stack_web() {
  start web web "$@"
  web_pid=$last_pid
  stack_await "$web_pid" 60 stack_web_ready
}
