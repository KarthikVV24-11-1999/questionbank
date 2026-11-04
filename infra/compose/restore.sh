#!/bin/sh
# Restores the Compose stack's database from a backup (M8-50): `infra/compose/restore.sh <file>`.
#
# It stops the services that write (the API, and the two that proxy to it), drops the `questionbank` database, makes it again, and loads the backup into it. THE DATABASE IS REPLACED:
# whatever it held since the backup is gone. It does not start the services again, because what to do next is the person's call (look at what was restored first); it says how.
# Restoring into a database that does not exist, or into an empty volume, works the same way.
set -eu
[ "$#" -eq 1 ] && [ -s "$1" ] || { echo "usage: restore.sh <backup file>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
docker=${QB_DOCKER:-docker}
compose() { $docker compose -f "$here/docker-compose.yml" "$@"; }
compose stop api learn studio
compose exec -T postgres dropdb -U postgres --if-exists --force questionbank
compose exec -T postgres createdb -U postgres questionbank
compose exec -T postgres pg_restore -U postgres --dbname=questionbank --exit-on-error --no-owner < "$1"
echo "restore.sh: restored from $1. Start the services: docker compose -f \"$here/docker-compose.yml\" up -d --wait"
