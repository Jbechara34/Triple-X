# Builds monerod straight from the official source tree, per the documented
# Ubuntu build instructions in monero-project/monero's README.
#
# NOTE: this is a from-source, non-static-ish "release" build using the
# project's Makefile. On modest hardware (the kind Umbrel/Start9 boxes tend
# to be) this can take well over an hour and needs a few GB of RAM - that's
# normal for compiling Monero. If that's not acceptable for your box, see
# README.md -> "Using prebuilt binaries instead" for a drop-in alternative
# that downloads the official signed release binary instead of compiling.
#
# MONERO_REF tracks the release-v0.18 branch by default (current stable line
# as of writing - v0.18.5.x). Pin it to an exact tag (e.g. v0.18.5.1) for
# reproducible builds.

ARG MONERO_REPO=https://github.com/monero-project/monero.git
ARG MONERO_REF=release-v0.18

FROM ubuntu:24.04 AS builder
ARG MONERO_REPO
ARG MONERO_REF
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential cmake pkg-config ca-certificates \
    libssl-dev libzmq3-dev libunbound-dev libsodium-dev libunwind8-dev \
    liblzma-dev libreadline6-dev libexpat1-dev libpgm-dev qttools5-dev-tools \
    libhidapi-dev libusb-1.0-0-dev libprotobuf-dev protobuf-compiler libudev-dev \
    libboost-chrono-dev libboost-date-time-dev libboost-filesystem-dev \
    libboost-locale-dev libboost-program-options-dev libboost-regex-dev \
    libboost-serialization-dev libboost-system-dev libboost-thread-dev \
    ccache doxygen graphviz curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --branch "${MONERO_REF}" --depth 1 "${MONERO_REPO}" monero && \
    cd monero && \
    git submodule sync && git submodule update --init --force --recursive --depth 1

WORKDIR /build/monero
# `nproc` builds can exhaust RAM on small boxes (e.g. 4GB Raspberry Pi-class
# hardware). If the build OOM-kills, retry with `make -j2` or lower.
RUN make release -j"$(nproc)"

# The exact output path has moved around across Monero versions
# (build/release/bin vs build/Linux/<tag>/release/bin) - find it instead of
# hardcoding it, so this Dockerfile keeps working across releases.
RUN mkdir -p /out && \
    cp "$(find /build/monero/build -maxdepth 5 -type f -name monerod | head -n1)" /out/monerod

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libzmq5 libunbound8 libsodium23 libunwind8 \
    libpgm-5.3-1t64 tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/monerod /usr/local/bin/monerod

RUN useradd -r -u 1000 -m -d /home/monero -s /usr/sbin/nologin monero
USER monero
WORKDIR /home/monero

EXPOSE 18080 18081 18083
VOLUME ["/home/monero/.bitmonero"]

ENTRYPOINT ["/usr/bin/tini", "--", "monerod"]
CMD ["--help"]
