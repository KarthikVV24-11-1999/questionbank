#!/bin/sh
# Takes a backup of the Compose stack's database (M8-50): `infra/compose/backup.sh <file>`.
#
# One command: a custom-format `pg_dump` of the `questionbank` database, run inside the postgres container, so it needs no client on the host and no password (the container's own socket
# is trusted; the published port is not, D123). `pg_dump` reads one consistent snapshot while the API is running, so nothing has to be stopped. The file is written under a temporary name
# and moved into place only when it is not empty and `pg_restore --list` can read it, so a backup that is there is a backup that can be read; a backup that can be read is not yet one that
# restores, which is what `restore.sh` and the drill (`restore-drill.mjs`) are for.
#
# Not here: where the file goes. It is on the host's disk when this ends, which is the host this protects against nothing (docs/DEPLOYMENT.md says where it must go).
set -eu
[ "$#" -eq 1 ] || { echo "usage: backup.sh <file>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
docker=${QB_DOCKER:-docker}
partial="$1.partial"
trap 'rm -f "$partial"' EXIT
$docker compose -f "$here/docker-compose.yml" exec -T postgres pg_dump -U postgres --format=custom --no-owner questionbank > "$partial"
[ -s "$partial" ] || { echo "backup.sh: the dump is empty" >&2; exit 1; }
$docker compose -f "$here/docker-compose.yml" exec -T postgres pg_restore --list < "$partial" > /dev/null || { echo "backup.sh: the dump cannot be read back" >&2; exit 1; }
mv "$partial" "$1"
echo "backup.sh: $(wc -c < "$1" | tr -d ' ') bytes in $1"
