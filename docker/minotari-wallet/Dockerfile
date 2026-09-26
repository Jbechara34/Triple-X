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

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
