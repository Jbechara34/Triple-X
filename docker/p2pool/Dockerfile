# Builds p2pool from the official source tree (SChernykh/p2pool), following
# the same steps as the project's own Dockerfile, then swaps in our own
# entrypoint (see entrypoint.sh) that reads wallet address / pool mode from
# the dashboard's Settings tab and restarts p2pool when they change, instead
# of requiring a container restart.
#
# P2POOL_REF tracks the master branch by default. Pin it to an exact tag
# (e.g. v4.16) for reproducible builds - check
# https://github.com/SChernykh/p2pool/releases for the current version, and
# watch that page for security advisories.

ARG P2POOL_REPO=https://github.com/SChernykh/p2pool.git
ARG P2POOL_REF=master

FROM debian:12-slim AS builder
ARG P2POOL_REPO
ARG P2POOL_REF
RUN set -e && \
    apt-get update -q -y --no-install-recommends && \
    DEBIAN_FRONTEND=noninteractive apt-get install -q -y --no-install-recommends \
        git build-essential ca-certificates cmake \
        libuv1-dev libzmq3-dev libsodium-dev libpgm-dev libnorm-dev libgss-dev libcurl4-openssl-dev

WORKDIR /usr/src/p2pool
RUN git clone --branch "${P2POOL_REF}" --depth 1 "${P2POOL_REPO}" . && \
    git submodule update --init --recursive --depth 1 && \
    mkdir build && cd build && cmake .. && make -j"$(nproc)"

FROM debian:12-slim
COPY --from=builder /usr/src/p2pool/build/p2pool /usr/local/bin/p2pool

RUN set -e && \
    apt-get update -q -y --no-install-recommends && \
    DEBIAN_FRONTEND=noninteractive apt-get install -q -y --no-install-recommends \
        libzmq5 libuv1 libcurl4 tini jq && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN groupadd -r p2pool -g 1000 && \
    useradd -u 1000 -r -g p2pool -s /usr/sbin/nologin -c "p2pool user" p2pool && \
    mkdir -p /home/p2pool/.p2pool && \
    chown -R p2pool:p2pool /home/p2pool

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER p2pool
WORKDIR /home/p2pool/.p2pool

EXPOSE 3333 37888 37889 37890
VOLUME ["/home/p2pool/.p2pool"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
