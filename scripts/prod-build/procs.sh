# shellcheck shell=bash
# The production-build check's processes (scripts/prod-build-check.sh sources this). Each runs
# in a process group of its own and is stopped whole: when its case ends, when the check exits
# or is stopped, and, by a watchdog, when the check is killed outright. Written for macOS's
# bash 3.2, which has no `timeout`, under `set -u`.
#
# procs_setup <folder> comes first: it makes <folder>/logs, sets the traps, starts the
# watchdog, and removes <folder> when the check exits. Then:
#   start <name> <command...>       starts a process that stays up, its output in logs/<name>.log;
#   run_for <seconds> <command...>  runs a case to its end, or stops it at its deadline;
#   ended_as <status>               says in words how a case ended.
# A case's output goes where the caller sends run_for's: a file, never $(...). Inside $(...) the
# traps can't stop the case (the subshell has its own copy of this file's state), and the caller
# waits until every process holding the output has closed it.

procs_dir=''
procs_watchdog=''
procs_stopping=0
running=''        # run_for's group, while a case runs
last_pid=''       # the leader of the group start started last
launch_pending='' # "yes" while launch forks, until its caller has recorded the group
launch_before=''  # $! before that fork
bg_pid=''         # $!, as last_bg reads it

# Reads $! into bg_pid, empty before any background job: under set -u, bash 3.2 calls $! unbound
# then, even as ${!:-}.
last_bg() {
  case $- in
    *u*)
      set +u
      bg_pid="$!"
      set -u
      ;;
    *) bg_pid="$!" ;;
  esac
}

# Kills process group $1 until it's empty: on macOS a child being forked as a KILL reaches its
# group joins the group without getting the KILL. Returns 1 if the group still isn't empty after
# about 2.5 seconds.
kill_group() {
  local tries=50
  while kill -KILL -- "-$1" 2>/dev/null; do
    [ "$tries" -gt 0 ] || return 1
    sleep 0.05
    tries=$((tries - 1))
  done
  return 0
}

# Starts the command in a process group of its own, its input /dev/null and its output where
# the caller sends launch's; $! is then the group's id. Job control is on only for the fork: on
# for a foreground command, it would hand that command the terminal. A trap that runs before the
# caller has recorded the group finds it through launch_pending: if $! has moved from
# launch_before, the fork happened.
launch() {
  last_bg
  launch_before="$bg_pid"
  launch_pending=yes
  set -m
  "$@" </dev/null &
  set +m
}

# Starts the command after the name, its output in logs/<name>.log; last_pid is then the leader
# of its group, which end_groups stops.
start() {
  local name="$1"
  shift
  launch "$@" >"$procs_dir/logs/$name.log" 2>&1
  last_pid=$!
  echo "$last_pid $name" >>"$procs_dir/groups"
  launch_pending=''
}

# Runs the command after $1 to its end, or stops its group after $1 seconds and returns 124. A
# command that ends but leaves a process in its group, given a second for a child that's still
# exiting, returns 125, the process stopped. Killing only the process run_for starts would leave
# its children running: the check's web() is a subshell that execs the server, so the server
# would outlive the deadline, still listening.
run_for() {
  local deadline=$((SECONDS + $1)) pid status tries=5
  shift
  launch "$@"
  pid=$!
  running="$pid"
  [ -z "$procs_dir" ] || echo "$pid" >"$procs_dir/running"
  launch_pending=''
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      stop_running
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.2
  done
  wait "$pid"
  status=$?
  while kill -0 -- "-$pid" 2>/dev/null; do
    if [ "$tries" -eq 0 ]; then
      stop_running
      return 125
    fi
    sleep 0.2
    tries=$((tries - 1))
  done
  stop_running
  return "$status"
}

# How a run_for status says the command ended, for a failure's message.
ended_as() {
  case "$1" in
    124) echo "still running at its deadline" ;;
    125) echo "ended, but left a process running" ;;
    *) echo "exit $1" ;;
  esac
}

# Stops run_for's case, if one is running.
stop_running() {
  [ -n "$running" ] || return 0
  kill_group "$running" || echo "prod-build-check: process group $running didn't empty" >&2
  running=''
  [ -z "$procs_dir" ] || : >"$procs_dir/running"
}

# Stops each group start started: TERM, then KILL to any left after 15 seconds.
end_groups() {
  local group name tries=75 left
  [ -f "$procs_dir/groups" ] || return 0
  while read -r group name; do
    kill -TERM -- "-$group" 2>/dev/null
  done <"$procs_dir/groups"
  while [ "$tries" -gt 0 ]; do
    left=0
    while read -r group name; do
      kill -0 -- "-$group" 2>/dev/null && left=1
    done <"$procs_dir/groups"
    [ "$left" = 0 ] && return 0
    sleep 0.2
    tries=$((tries - 1))
  done
  while read -r group name; do
    if kill -0 -- "-$group" 2>/dev/null; then
      echo "prod-build-check: $name didn't stop in 15 seconds; killing it" >&2
      kill_group "$group"
    fi
  done <"$procs_dir/groups"
}

# Stops everything, once: a launch a trap interrupted, the case, the groups and the watchdog,
# then removes the folder.
procs_cleanup() {
  [ "$procs_stopping" = 1 ] && return 0
  procs_stopping=1
  trap '' INT TERM HUP
  set +m
  last_bg
  if [ "$launch_pending" = yes ] && [ "$bg_pid" != "$launch_before" ]; then
    kill_group "$bg_pid"
  fi
  stop_running
  end_groups
  [ -z "$procs_watchdog" ] || kill_group "$procs_watchdog"
  rm -rf "$procs_dir"
}

# Stops what the check started if the check is killed outright, which no trap sees: a KILL to
# the check, or to its process group, misses the groups its processes run in. It runs in a group
# of its own, ignores the signals that stop the check, and does nothing once the folder is gone.
procs_watch() {
  trap '' INT TERM HUP PIPE
  while kill -0 "$1" 2>/dev/null; do
    sleep 1
  done
  [ -d "$procs_dir" ] || return 0
  echo "prod-build-check: the check was killed before it stopped its processes; stopping them" >&2
  running="$(cat "$procs_dir/running" 2>/dev/null)"
  stop_running
  end_groups
  rm -rf "$procs_dir"
}

# Sets up the folder given for this file's processes; the check exits 130, 143 or 129 on INT,
# TERM or HUP, after stopping them.
procs_setup() {
  procs_dir="$1"
  (umask 077 && mkdir -p "$procs_dir/logs" && : >"$procs_dir/running") || return 2
  trap 'procs_cleanup' EXIT
  trap 'procs_cleanup; exit 130' INT
  trap 'procs_cleanup; exit 143' TERM
  trap 'procs_cleanup; exit 129' HUP
  set -m
  procs_watch "$$" </dev/null >/dev/null &
  procs_watchdog=$!
  set +m
}
