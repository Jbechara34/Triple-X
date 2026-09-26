#!/bin/sh
# Supervises p2pool: reads wallet address + pool mode from the settings.json
# file the dashboard backend writes (lib/config.js), builds the matching
# p2pool command line, and restarts p2pool whenever that file changes - so
# saving Settings in the UI takes effect without a container restart.
set -u

CONFIG_FILE="${CONFIG_FILE:-/data/config/settings.json}"
DATA_API_DIR="${DATA_API_DIR:-/data/p2pool-api}"
LOG_DIR="${LOG_DIR:-/data/p2pool-logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/p2pool.log}"

# The Dockerfile leaves this container running as root (no USER) because
# bind-mounted volumes (e.g. Umbrel/5tratumOS's ${APP_DATA_DIR} paths) arrive
# owned by root regardless of what the image sets up - unlike Docker-managed
# named volumes, a bind mount doesn't inherit the image directory's
# ownership. So: chown everything p2pool needs to write while we're still
# root, then re-exec this same script as the unprivileged p2pool user before
# touching any settings or starting p2pool.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_API_DIR" "$LOG_DIR" "$(dirname "$CONFIG_FILE")" /home/p2pool/.p2pool 2>/dev/null || true
  chown p2pool:p2pool "$DATA_API_DIR" "$LOG_DIR" "$(dirname "$CONFIG_FILE")" /home/p2pool/.p2pool 2>/dev/null || true
  # setpriv only changes the process's UID/GID - unlike `su`/`sudo -i`, it
  # does NOT reset HOME, which would otherwise stay HOME=/root (inherited
  # from this root shell) and could point anything that defaults to
  # $HOME at the wrong, inaccessible directory. Confirmed as the cause of
  # monerod's near-identical "Permission denied: /root/.bitmonero" crash -
  # see docker/monerod/entrypoint.sh.
  export HOME=/home/p2pool
  exec setpriv --reuid=p2pool --regid=p2pool --init-groups "$0" "$@"
fi

MONEROD_HOST="${MONEROD_HOST:-monerod}"
MONEROD_RPC_PORT="${MONEROD_RPC_PORT:-18081}"
MONEROD_ZMQ_PORT="${MONEROD_ZMQ_PORT:-18083}"
STRATUM_BIND="${STRATUM_BIND:-0.0.0.0:3333}"
P2P_BIND="${P2P_BIND:-0.0.0.0}"

mkdir -p "$DATA_API_DIR" "$LOG_DIR" "$(dirname "$CONFIG_FILE")" 2>/dev/null || true

# p2pool's own output only ever goes to $LOG_FILE below (start_child), never
# to this container's stdout - so `docker logs`/the platform's log viewer
# showed nothing useful when p2pool crashed on startup. Mirror the log file
# to stdout too, decoupled from p2pool's own process so it doesn't affect
# the PID tracking / restart logic below. `-n0` skips existing content (the
# dashboard's Logs tab already shows that), `-F` waits for/follows the file
# even if it doesn't exist yet or gets rotated.
touch "$LOG_FILE"
tail -n0 -F "$LOG_FILE" &

CHILD_PID=""
LAST_SIGNATURE=""

term_handler() {
  echo "[entrypoint] caught signal, stopping p2pool..."
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null
    wait "$CHILD_PID" 2>/dev/null
  fi
  exit 0
}
trap term_handler TERM INT

read_setting() {
  # $1 = jq filter. Empty/missing config -> empty string, never an error exit.
  if [ -f "$CONFIG_FILE" ]; then
    jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null
  fi
}

build_args() {
  WALLET="$(read_setting '.walletAddress')"
  MODE="$(read_setting '.poolMode')"
  [ -z "${MODE:-}" ] && MODE="standard"

  if [ -z "${WALLET:-}" ]; then
    ARGS=""
    return 1
  fi

  ARGS="--host $MONEROD_HOST --rpc-port $MONEROD_RPC_PORT --zmq-port $MONEROD_ZMQ_PORT"
  ARGS="$ARGS --wallet $WALLET"
  ARGS="$ARGS --stratum $STRATUM_BIND"

  case "$MODE" in
    mini)
      ARGS="$ARGS --mini --p2p ${P2P_BIND}:37888"
      ;;
    nano)
      ARGS="$ARGS --nano --p2p ${P2P_BIND}:37890"
      ;;
    standard|*)
      ARGS="$ARGS --p2p ${P2P_BIND}:37889"
      ;;
  esac

  # --data-api/--local-api/--stratum-api feed the dashboard's Pool/Blocks
  # tabs (see app/lib/p2poolApi.js and app/lib/blocks.js).
  ARGS="$ARGS --data-api $DATA_API_DIR --local-api --stratum-api"

  # Extra flags passed straight through from docker-compose.yml, e.g.
  # --out-peers/--in-peers tuning or --light-mode.
  if [ -n "${P2POOL_EXTRA_ARGS:-}" ]; then
    ARGS="$ARGS $P2POOL_EXTRA_ARGS"
  fi

  return 0
}

start_child() {
  echo "[entrypoint] starting: p2pool $ARGS" | tee -a "$LOG_FILE"
  # shellcheck disable=SC2086
  p2pool $ARGS >>"$LOG_FILE" 2>&1 &
  CHILD_PID=$!
  LAST_SIGNATURE="$ARGS"
}

stop_child() {
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "[entrypoint] settings changed, restarting p2pool..." | tee -a "$LOG_FILE"
    kill -TERM "$CHILD_PID" 2>/dev/null
    wait "$CHILD_PID" 2>/dev/null
  fi
  CHILD_PID=""
}

echo "[entrypoint] waiting for a payout address to be configured (Settings tab)..."
while true; do
  if build_args; then
    break
  fi
  sleep 5
done

start_child

while true; do
  sleep 10

  # Child died on its own (crash, RPC unreachable, etc.) - restart as-is.
  if [ -n "$CHILD_PID" ] && ! kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "[entrypoint] p2pool exited unexpectedly, restarting in 5s..." | tee -a "$LOG_FILE"
    sleep 5
    if build_args; then
      start_child
    else
      echo "[entrypoint] no payout address configured, waiting..." | tee -a "$LOG_FILE"
      while ! build_args; do sleep 5; done
      start_child
    fi
    continue
  fi

  # Settings changed - hot restart with the new args.
  if build_args && [ "$ARGS" != "$LAST_SIGNATURE" ]; then
    stop_child
    start_child
  fi
done
