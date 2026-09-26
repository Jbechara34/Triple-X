#!/bin/sh
# Generates and persists a wallet password on first run if one isn't
# supplied via MINOTARI_WALLET_PASSWORD, so the wallet can start unattended
# (--non-interactive) without ever prompting - same idea as how p2pool's
# entrypoint.sh waits for a payout address instead of requiring one at
# build time.
set -eu

PASSWORD_FILE="/tari-data/.wallet-password"

if [ -z "${MINOTARI_WALLET_PASSWORD:-}" ]; then
  mkdir -p /tari-data
  if [ -f "$PASSWORD_FILE" ]; then
    MINOTARI_WALLET_PASSWORD="$(cat "$PASSWORD_FILE")"
  else
    MINOTARI_WALLET_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "$MINOTARI_WALLET_PASSWORD" > "$PASSWORD_FILE"
    chmod 600 "$PASSWORD_FILE"
  fi
  export MINOTARI_WALLET_PASSWORD
fi

exec minotari_console_wallet "$@"
