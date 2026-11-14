#!/usr/bin/env bash
# Development and test databases on a local Postgres 18 (docs/specs/platform.md, "The
# development database"): Homebrew's cluster on the Mac, the postgres:18 service in CI.
#
# It creates, when missing, the roles instante_owner (CREATEDB, for template databases) and
# instante_app, and the databases instante_dev and instante_test, owned by instante_owner, from
# template0 with the pinned locale. It writes their connection URLs to .dev/secrets/ and
# migrates both. Safe to run again: it creates only what's missing and never drops anything.
#
# It connects with the usual PG* variables (PGHOST, PGPORT, PGUSER), as a role that may create
# roles and databases: on the Mac, your own Homebrew superuser. Never point it at the
# real-use cluster in ~/.instante. Written for macOS's bash 3.2.
set -u -o pipefail

# The repository this script lives in, whatever folder it's run from.
root="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 2
[ -n "$root" ] && [ -f "$root/apps/backend/src/main.ts" ] || {
  echo "dev-db: can't find the repository around $0" >&2
  exit 2
}
cd "$root" || exit 2

host="${PGHOST:-localhost}"
port="${PGPORT:-5432}"
export PGHOST="$host" PGPORT="$port"

# TCP on loopback only: the URLs it writes name a host, and the real-use cluster in
# ~/.instante listens on a socket folder and never on TCP.
case "$host" in
  localhost | 127.0.0.1) ;;
  *)
    echo "dev-db: PGHOST must be localhost or 127.0.0.1, not $host" >&2
    exit 2
    ;;
esac

psql_admin() {
  psql -X -v ON_ERROR_STOP=1 -q -d postgres "$@"
}

echo "dev-db: roles"
psql_admin <<'SQL' || exit 1
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'instante_owner') THEN
    CREATE ROLE instante_owner LOGIN CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'instante_app') THEN
    CREATE ROLE instante_app LOGIN;
  END IF;
END
$$;
SQL

secrets=".dev/secrets"
mkdir -p "$secrets" || exit 1
chmod 700 .dev "$secrets" || exit 1

for name in dev test; do
  db="instante_$name"
  exists="$(psql_admin -At -c "SELECT 1 FROM pg_database WHERE datname = '$db'")" || exit 1
  if [ "$exists" != "1" ]; then
    echo "dev-db: creating $db"
    psql_admin -c "CREATE DATABASE $db OWNER instante_owner TEMPLATE template0
      ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'" || exit 1
  fi

  # Database-level rights aren't part of a database's contents, so they're set here each time:
  # no temporary objects or connections for PUBLIC, and a connection for the app role.
  psql_admin -c "REVOKE TEMPORARY, CONNECT ON DATABASE $db FROM PUBLIC" -c \
    "GRANT CONNECT ON DATABASE $db TO instante_app" || exit 1

  for role in owner app; do
    file="$secrets/$role-$name.url"
    (umask 077 && printf 'postgresql://instante_%s@%s:%s/%s\n' "$role" "$host" "$port" "$db" >"$file") ||
      exit 1
  done

  echo "dev-db: migrating $db"
  INSTANTE_ENV=development ROLE=cli OWNER_DATABASE_URL_FILE="$PWD/$secrets/owner-$name.url" \
    node --disable-sigusr1 apps/backend/src/main.ts db migrate || exit 1
done

echo "dev-db: done. URLs are in $secrets/"
