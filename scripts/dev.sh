#!/usr/bin/env bash
# pnpm dev (docs/specs/platform.md, "Local development and end-to-end runs"): the document
# service, the backend and the web app from source, with INSTANTE_ENV=development:
#   - the document service on a socket in a folder of its own under $TMPDIR, mode 0700: short,
#     since macOS caps a socket's path at 104 bytes and a deep worktree can pass that;
#   - the backend (ROLE=all) on 127.0.0.1:8080, once the service answers;
#   - the web app (next dev) on 127.0.0.1:3000, opened at http://localhost:3000, once the
#     backend's /readyz answers.
# Each starts from an empty environment plus its own names, as the launcher starts them, so
# nothing from your shell (keys, tokens) reaches them. Ctrl-C, TERM, HUP, or any one of the
# three stopping, stops the others and removes the folder. Each line of output starts with its
# process's name. Run scripts/dev-db.sh once first.
#
# DEV_WEB_PORT and DEV_BACKEND_PORT move it off 3000 and 8080 (its own tests use them); the
# ports real use and the end-to-end tests own are refused. Written for macOS's bash 3.2: no
# `wait -n`, so it polls its children.
set -u -o pipefail

# The repository this script lives in, whatever folder it's run from.
root="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 2
[ -n "$root" ] && [ -f "$root/apps/backend/src/main.ts" ] || {
  echo "dev: can't find the repository around $0" >&2
  exit 2
}
cd "$root" || exit 2

# `pnpm dev -- …` passes the `--` on. No options yet: accounts adds --fake-supabase (A6).
[ "${1:-}" = "--" ] && shift
if [ "$#" -gt 0 ]; then
  echo "dev: unknown argument $1 (usage: scripts/dev.sh)" >&2
  exit 2
fi

web_port="${DEV_WEB_PORT:-3000}"
backend_port="${DEV_BACKEND_PORT:-8080}"
for port in "$web_port" "$backend_port"; do
  case "$port" in
    '' | *[!0-9]* | 0*)
      echo "dev: a port must be a number from 1 to 65535, not '$port'" >&2
      exit 2
      ;;
    4310 | 4311 | 4320 | 4321)
      echo "dev: port $port belongs to real use or the end-to-end tests" >&2
      exit 2
      ;;
  esac
  if [ "$port" -gt 65535 ]; then
    echo "dev: a port must be a number from 1 to 65535, not '$port'" >&2
    exit 2
  fi
done
allowed_host="localhost:$web_port"
backend_url="http://127.0.0.1:$backend_port"
database_url_file="$root/.dev/secrets/app-dev.url"
next_bin="$root/apps/web/node_modules/next/dist/bin/next"

[ -f "$database_url_file" ] || {
  echo "dev: $database_url_file is missing: run scripts/dev-db.sh first" >&2
  exit 2
}

# The Node that mise.toml pins, by its real path: under pnpm, `node` can be mise's `latest`.
pinned="$(sed -n 's/^node = "\([0-9.]*\)"$/\1/p' mise.toml)"
if ! node="$(command -v node)" || ! node="$("$node" -p process.execPath)"; then
  echo "dev: node isn't on PATH" >&2
  exit 2
fi
version="$("$node" --version)"
if [ -z "$pinned" ] || [ "$version" != "v$pinned" ]; then
  echo "dev: $node is $version, but mise.toml pins node ${pinned:-(none found)}" >&2
  exit 2
fi
node_dir="$(dirname "$node")"

# Nothing else may listen on either port, on any address: a server on ::1 or `localhost`
# would answer http://localhost:3000 in Instante's place, and a stale one would answer the
# readiness checks below.
for port in "$web_port" "$backend_port"; do
  holder="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n '2p')"
  if [ -n "$holder" ]; then
    echo "dev: port $port is in use: $holder" >&2
    exit 2
  fi
done

tmp="${TMPDIR:-/tmp}"
tmp="${tmp%/}"

# Folders that runs killed before they could clean up left behind, with any job folders in
# them: each holds only a socket nothing answers on any more.
for old in "$tmp"/instante-dev.*; do
  [ -d "$old" ] && [ -O "$old" ] || continue
  if ! curl -s -o /dev/null --max-time 2 --unix-socket "$old/documents.sock" http://documents/; then
    rm -rf "$old"
  fi
done

# The socket's folder. mktemp -d makes it 0700; the document service refuses anything wider.
run="$(mktemp -d "$tmp/instante-dev.XXXXXX")" || exit 1
socket="$run/documents.sock"

names=()
pids=()
stopping=0

# Stops every process still running, at most once: TERM to each one's process group (next dev's
# server and Turbopack's workers are in its group), up to 15 seconds (the backend's grace is
# 10), then KILL.
stop() {
  [ "$stopping" = 1 ] && return 0
  stopping=1
  # Another signal now would run its trap inside this one and exit before the folder goes; the
  # KILL below bounds the wait instead. Every child is already running, so none inherits this.
  trap '' INT TERM HUP
  local i pid tries
  if [ "${#pids[@]}" -gt 0 ]; then
    for pid in "${pids[@]}"; do
      kill -TERM -- "-$pid" 2>/dev/null
    done
    tries=75
    while [ "$tries" -gt 0 ]; do
      i=0
      for pid in "${pids[@]}"; do
        kill -0 -- "-$pid" 2>/dev/null && i=$((i + 1))
      done
      [ "$i" -eq 0 ] && break
      sleep 0.2
      tries=$((tries - 1))
    done
    for i in "${!pids[@]}"; do
      if kill -0 -- "-${pids[$i]}" 2>/dev/null; then
        echo "dev: ${names[$i]} didn't stop in 15 seconds; killing it" >&2
        kill -KILL -- "-${pids[$i]}" 2>/dev/null
      fi
    done
  fi
  rm -rf "$run"
}
trap 'stop' EXIT
trap 'stop; exit 130' INT
trap 'stop; exit 143' TERM
trap 'stop; exit 129' HUP

# Copies its input to stdout, each line after the name in $1. It ignores Ctrl-C and TERM, and
# ends when the process it reads from closes its output, so that process can still write while
# it stops (a broken pipe would end it before it cleans up).
label() {
  trap '' INT TERM HUP
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%-12s %s\n' "[$1]" "$line"
  done
}

# Starts the command after the name and its folder in its own process group, so a Ctrl-C
# reaches only this script, which then stops each group once (a second, different signal makes
# the backend's own stop fail). Job control is on only while it starts: on for a foreground
# command, it would hand that command the terminal, and Ctrl-C would stop that command alone.
start() {
  local name="$1" dir="$2"
  shift 2
  set -m
  (cd "$dir" && exec "$@") </dev/null > >(label "$name") 2>&1 &
  pids+=("$!")
  names+=("$name")
  set +m
}

# Waits up to $2 seconds for the command after them to succeed, while process $1 runs.
await() {
  local pid="$1" tries=$(($2 * 5))
  shift 2
  while [ "$tries" -gt 0 ]; do
    kill -0 "$pid" 2>/dev/null || return 1
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.2
    tries=$((tries - 1))
  done
  return 1
}

# Says which process ended, and how, or that it never became ready, then exits; the EXIT trap
# stops the others.
ended() {
  local status
  if kill -0 "$2" 2>/dev/null; then
    echo "dev: $1 didn't become ready in time; stopping everything" >&2
  else
    wait "$2" 2>/dev/null
    status=$?
    echo "dev: $1 stopped (exit status $status); stopping the others" >&2
  fi
  exit 1
}

# The web app's home page answers 200 only once it has compiled; a 421 from proxy.ts comes
# before any page works.
web_ready() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Host: $allowed_host" \
    "http://127.0.0.1:$web_port/")" = 200 ]
}

echo "dev: document service on $socket"
start documents . env -i INSTANTE_ENV=development ROLE=documents DOCUMENTS_SOCKET="$socket" \
  "$node" --disable-sigusr1 apps/backend/src/main.ts
await "${pids[0]}" 30 curl -s -o /dev/null --max-time 2 --unix-socket "$socket" http://documents/ ||
  ended documents "${pids[0]}"

echo "dev: backend on $backend_url"
start backend . env -i INSTANTE_ENV=development ROLE=all LISTEN_ADDRESS=127.0.0.1 \
  PORT="$backend_port" ALLOWED_HOST="$allowed_host" DATABASE_URL_FILE="$database_url_file" \
  DOCUMENTS_SOCKET="$socket" "$node" --disable-sigusr1 apps/backend/src/main.ts
await "${pids[1]}" 60 curl -fs -o /dev/null --max-time 6 "$backend_url/readyz" ||
  ended backend "${pids[1]}"

# Next starts in apps/web, since it resolves next.config.ts's own imports from its working
# folder. Its environment wins over apps/web/.env.local. PATH leads with the pinned Node, which
# Turbopack's workers start by name.
echo "dev: web on 127.0.0.1:$web_port"
start web apps/web env -i PATH="$node_dir:/usr/bin:/bin" TMPDIR="$tmp" \
  NEXT_TELEMETRY_DISABLED=1 ALLOWED_HOST="$allowed_host" BACKEND_INTERNAL_URL="$backend_url" \
  "$node" --disable-sigusr1 "$next_bin" dev -H 127.0.0.1 -p "$web_port"
await "${pids[2]}" 120 web_ready || ended web "${pids[2]}"

# Every listener on the web port must be next dev's own.
for pid in $(lsof -nP -t -iTCP:"$web_port" -sTCP:LISTEN 2>/dev/null); do
  if [ "$(ps -o pgid= -p "$pid" | tr -d ' ')" != "${pids[2]}" ]; then
    echo "dev: another process listens on port $web_port too: $(ps -o command= -p "$pid")" >&2
    exit 1
  fi
done
echo "dev: open http://$allowed_host"

# bash 3.2 has no `wait -n`: poll each one.
while :; do
  for i in "${!pids[@]}"; do
    kill -0 "${pids[$i]}" 2>/dev/null || ended "${names[$i]}" "${pids[$i]}"
  done
  sleep 1
done
