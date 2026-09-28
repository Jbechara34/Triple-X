#!/bin/sh
# Generates and persists a wallet password on first run if one isn't
# supplied via MINOTARI_WALLET_PASSWORD, so the wallet can start unattended
# (--non-interactive) without ever prompting - same idea as how p2pool's
# entrypoint.sh waits for a payout address instead of requiring one at
# build time.
set -eu

mkdir -p /tari-data

PASSWORD_FILE="/tari-data/.wallet-password"
# Written by the app (lib/tariWalletRecovery.js, same volume as this
# container's own /tari-data) right before restarting this container as
# part of the Wallet tab's "Recover Wallet" button. Its presence means: wipe
# whatever wallet is here and start fresh from these seed words instead.
RECOVERY_FILE="/tari-data/recover-seed-words.txt"
# Written by the app (lib/tariWallet.js's requestWalletCreation) when the
# user clicks "Create Wallet" on the Wallet tab. A wallet is never generated
# just because this container exists - see the wait loop below.
CREATE_REQUEST_FILE="/tari-data/create-wallet-requested"
# Marks that a wallet has been created (or recovered) at least once, so a
# later restart of an existing wallet never waits again.
INIT_MARKER="/tari-data/.wallet-initialized"

if [ -z "${MINOTARI_WALLET_PASSWORD:-}" ]; then
  if [ -f "$PASSWORD_FILE" ]; then
    MINOTARI_WALLET_PASSWORD="$(cat "$PASSWORD_FILE")"
  else
    MINOTARI_WALLET_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "$MINOTARI_WALLET_PASSWORD" > "$PASSWORD_FILE"
    chmod 600 "$PASSWORD_FILE"
  fi
  export MINOTARI_WALLET_PASSWORD
fi

if [ -f "$RECOVERY_FILE" ]; then
  RECOVERY_SEED_WORDS="$(cat "$RECOVERY_FILE")"
  # Read into a variable before removing - the app already wipes the old
  # wallet db from its side before restarting this container, but this is
  # the file whose presence means "recover", so it's removed first to avoid
  # re-triggering recovery on a later restart if the wallet process itself
  # then crashes.
  rm -f "$RECOVERY_FILE"
  touch "$INIT_MARKER"
  exec minotari_console_wallet "$@" --seed-words "$RECOVERY_SEED_WORDS"
fi

if [ ! -f "$INIT_MARKER" ]; then
  # Back-compat: an install upgrading from before this wait existed already
  # has real wallet data sitting here - don't make an existing wallet wait
  # for a "Create Wallet" click it already went through long ago. Only a
  # truly first-ever run (nothing here but the password file) waits.
  existing="$(ls -A /tari-data 2>/dev/null | grep -v -E '^(\.wallet-password|create-wallet-requested|recover-seed-words\.txt)$' | head -n 1)"
  if [ -n "$existing" ]; then
    touch "$INIT_MARKER"
  fi
fi

if [ ! -f "$INIT_MARKER" ]; then
  echo "Waiting for a wallet creation request from the dashboard (Wallet tab -> Create Wallet)..."
  while [ ! -f "$CREATE_REQUEST_FILE" ]; do
    sleep 2
  done
  rm -f "$CREATE_REQUEST_FILE"
  touch "$INIT_MARKER"
fi

exec minotari_console_wallet "$@"
