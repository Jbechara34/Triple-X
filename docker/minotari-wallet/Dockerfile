# Thin wrapper around Tari's own official console wallet image - we don't
# build Tari from source ourselves (it's a much larger, faster-moving Rust
# codebase than Monero/P2Pool, and official Docker images already exist).
# All this adds is a non-interactive password (auto-generated and persisted
# on first run if one isn't supplied) so the wallet can start unattended in
# a container, the same way monerod/p2pool do.
#
# See ../monerod/Dockerfile and ../p2pool/Dockerfile for the equivalent
# pattern already used elsewhere in this project.

FROM ghcr.io/tari-project/minotari_console_wallet:latest-mainnet

# The base image's own config sets a non-root "tari" user by default
# (confirmed via its published manifest: User=tari) - that user can't
# chmod /usr/local/bin (root-owned), which is exactly what broke this
# build ("chmod +x /usr/local/bin/entrypoint.sh" exiting 1). Switch to
# root just to install our entrypoint. Deliberately not switching back to
# a non-root user afterward - this is a minimal third-party base image and
# we can't assume it has setpriv/gosu/su-exec installed to drop privileges
# again safely, so the container runs as root throughout. Simplicity over
# defense-in-depth here; the wallet process itself is unchanged either way.
USER root

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
