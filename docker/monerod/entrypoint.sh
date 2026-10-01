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
  # -R matters here: a non-recursive chown only fixes the top-level
  # .bitmonero directory, not the lmdb/ subfolder (data.mdb/lock.mdb) inside
  # it - and that subfolder is exactly what monerod fails to open with
  # "Permission denied" when the bind-mounted volume's ownership gets reset
  # (e.g. by the host platform during an app update/restart), confirmed
  # directly from a user's logs: a ~26-minute restart-loop of "Failed to open
  # lmdb environment: Permission denied" that only cleared once whatever
  # external process finished reconciling ownership on its own. LMDB's own
  # on-disk format is just 1-2 files, so recursing here costs nothing.
  chown -R monero:monero /home/monero/.bitmonero /var/log/monerod 2>/dev/null || true
  # setpriv only changes the process's UID/GID - unlike `su`/`sudo -i`, it
  # does NOT reset HOME, so monerod would otherwise still see HOME=/root
  # (inherited from this root shell) and try to use /root/.bitmonero as its
  # default data dir, which the monero user can't access ("Permission
  # denied: /root/.bitmonero" - confirmed via a live container's logs).
  export HOME=/home/monero
  exec setpriv --reuid=monero --regid=monero --init-groups monerod "$@"
fi

exec monerod "$@"
