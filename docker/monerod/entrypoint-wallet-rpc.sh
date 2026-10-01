#!/bin/sh
# Runs monero-wallet-rpc in --wallet-dir mode (manages wallets by name via
# RPC calls like create_wallet/open_wallet, rather than requiring one fixed
# wallet file at startup) so the app container can create the dashboard's
# wallet on first use through lib/moneroWalletRpc.js.
#
# No --rpc-login: this port is never published to the host (see
# docker-compose.yml `expose`, not `ports`) and only reachable from other
# containers on the internal Docker network - same trust boundary monerod's
# own RPC already relies on (see docker/monerod/entrypoint.sh + moneroRpc.js).
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /home/monero/wallet-data /var/log/monero-wallet-rpc 2>/dev/null || true
  # -R matters here - see docker/monerod/entrypoint.sh for why a non-recursive
  # chown isn't enough once wallet files already exist underneath.
  chown -R monero:monero /home/monero/wallet-data /var/log/monero-wallet-rpc 2>/dev/null || true
  # setpriv only changes UID/GID, not HOME - without this, monero-wallet-rpc
  # inherits HOME=/root from this root shell and tries to use
  # /root/.shared-ringdb for its ring signature cache, which the monero user
  # can't access. This is the real cause of the "Failed to initialize ringdb:
  # ... Permission denied: /root/.shared-ringdb" error that otherwise repeats
  # on every RPC call - confirmed via a user's live logs. Same fix already
  # applied in docker/monerod/entrypoint.sh for the equivalent
  # /root/.bitmonero problem.
  export HOME=/home/monero
  exec setpriv --reuid=monero --regid=monero --init-groups monero-wallet-rpc "$@"
fi

exec monero-wallet-rpc "$@"
