#!/bin/sh
# The Dockerfile leaves this container running as root (no USER) because
# bind-mounted volumes (e.g. Umbrel/5tratumOS's ${APP_DATA_DIR} paths) arrive
# owned by root regardless of what the image sets up - unlike Docker-managed
# named volumes, a bind mount doesn't inherit the image directory's
# ownership. So: chown the directories monerod needs to write while we're
# still root, then drop to the unprivileged monero user via setpriv before
# exec'ing monerod itself.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /home/monero/.bitmonero /var/log/monerod 2>/dev/null || true
  chown monero:monero /home/monero/.bitmonero /var/log/monerod 2>/dev/null || true
  exec setpriv --reuid=monero --regid=monero --init-groups monerod "$@"
fi

exec monerod "$@"
