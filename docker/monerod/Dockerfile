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
# NOT `make release` - that target's cmake invocation never sets ARCH, and
# Monero's CMakeLists.txt defaults ARCH to "native" on Linux (see the
# set_default_arch() function there), which bakes in -march=<build machine's
# exact CPU>. That's fine on the GitHub Actions runner that compiles this,
# but the resulting binary hits SIGILL (exit code 132) the instant it runs
# on any CPU lacking one of those specific instructions - confirmed via the
# user's actual container status ("Restarting (132)"). Build the same way
# the official release-static-linux-x86_64 target does instead: ARCH
# explicitly set to the portable "x86-64" baseline, so the binary runs on
# any x86-64 CPU regardless of what compiled it.
#
# `nproc` builds can exhaust RAM on small boxes (e.g. 4GB Raspberry Pi-class
# hardware). If the build OOM-kills, retry with `-j2` or lower.
RUN mkdir -p build/release && \
    cd build/release && \
    cmake -D ARCH=x86-64 -D BUILD_64=ON -D CMAKE_BUILD_TYPE=Release ../.. && \
    make -j"$(nproc)"

# The exact output path has moved around across Monero versions
# (build/release/bin vs build/Linux/<tag>/release/bin) - find it instead of
# hardcoding it, so this Dockerfile keeps working across releases.
RUN mkdir -p /out && \
    cp "$(find /build/monero/build -maxdepth 5 -type f -name monerod | head -n1)" /out/monerod

# `make release` links monerod dynamically against Boost/OpenSSL/etc (it is
# NOT the static build the official release tarballs use - see
# Dockerfile.prebuilt for that). Rather than hand-listing every runtime
# package name the final stage needs to match (fragile - Ubuntu renames
# these across releases, e.g. the libpgm t64 transition), just copy every
# shared library the binary actually resolves to. Both stages are the same
# base image, so these are guaranteed ABI-compatible.
RUN mkdir -p /out/lib && \
    ldd /out/monerod | awk '{ if ($3 ~ /^\//) print $3 }' | sort -u | xargs -r cp -Lv -t /out/lib/

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/monerod /usr/local/bin/monerod
COPY --from=builder /out/lib/ /usr/local/lib/
RUN ldconfig

# ubuntu:24.04 ships a pre-existing "ubuntu" user at UID 1000 - remove it
# first so this UID is free (keeps the container's file ownership at a
# predictable 1000:1000 regardless of base-image changes).
RUN if getent passwd 1000 >/dev/null; then userdel -r "$(getent passwd 1000 | cut -d: -f1)"; fi && \
    useradd -r -u 1000 -m -d /home/monero -s /usr/sbin/nologin monero

# Pre-create and own the log directory here (not just at runtime) so that
# when docker-compose.yml mounts a volume at this path, Docker seeds it with
# monero:monero ownership instead of the root:root a fresh volume would
# otherwise get - monerod runs as the unprivileged "monero" user below and
# needs to write monerod.log here (see --log-file in docker-compose.yml).
RUN mkdir -p /var/log/monerod && chown monero:monero /var/log/monerod

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# No USER here (stays root) - entrypoint.sh chowns the mounted volumes and
# drops to the unprivileged monero user itself via setpriv before running
# monerod. See entrypoint.sh for why this is necessary.
WORKDIR /home/monero

EXPOSE 18080 18081 18083
VOLUME ["/home/monero/.bitmonero"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["--help"]
