# Monero Node + P2Pool Dashboard

A self-hosted Monero full node + [P2Pool](https://github.com/SChernykh/p2pool)
node, built from source, with a Monero-GUI-styled web dashboard for status,
pool stats, blocks found, and settings.

Payouts go straight to **your own wallet address** — there's no third party
pool operator and no custody of funds at any point. 0% fee, same as running
P2Pool directly.

## What's in here

| Tab | What it shows |
|---|---|
| **Main** | Sync status/progress, hashrate, best share vs. network difficulty, and a readiness checklist (Node RPC, payout address, blockchain sync, stratum). |
| **Pool** | Live stats for the P2Pool sidechain you're mining on (Standard/Mini/Nano): connected workers, hashrate over multiple windows, network difficulty/height, best share, per-worker detail, and the miner connection info (stratum URL + payout address + setup instructions). |
| **Blocks** | Blocks your node's P2Pool sidechain has found, each linking to a block explorer so you can independently verify the payout landed on your address. |
| **Settings** | Your Monero payout address and P2Pool mode (Standard / Mini / Nano). Saving here hot-restarts P2Pool with the new settings — no need to touch Docker. |

## Platforms

This repo doubles as two things:

1. **A plain Docker Compose stack** (`docker-compose.yml` at the repo root) —
   builds everything from source locally. Works anywhere Docker Compose runs.
2. **An Umbrel / 5tratumOS Community App Store** (`umbrel-app-store.yml` +
   `yourstore-monero-p2pool/`) — installable through the App Stores UI on
   umbrelOS or [5tratumOS](https://github.com/WillItMod/5tratum).

**On 5tratumOS specifically:** its own README documents it as "the host
platform, WebUI, update surface, and install media for running the
5tratum/AxeSuite app family," and its sibling
[AxeSuite](https://github.com/WillItMod/AxeSuite) repo confirms its apps
(AxeBTC, AxeDGB, AxeBCH — full node + solo pool apps much like this one) are
distributed as standard Umbrel Community App Store packages, installed via
`Settings → App Stores → Add store` the same way as on umbrelOS. So this repo
targets that same packaging convention rather than something bespoke — path
2 above should work on both platforms unchanged. If a future 5tratumOS
release diverges from Umbrel's app framework, the plain Docker Compose path
(1) will still work on it directly, as long as you can get a shell on it.

## Architecture

```
┌────────────┐      RPC/ZMQ       ┌────────────┐
│  monerod   │◄──────────────────►│   p2pool   │◄── your miner (XMRig, etc.)
│ (full node)│                    │            │     via stratum :3333
└─────┬──────┘                    └─────┬──────┘
      │ RPC (read-only)                 │ --data-api JSON files, log
      ▼                                 ▼
┌─────────────────────────────────────────────┐
│      web  (Node/Express + static UI)         │  :3000  ← the dashboard
└───────────────────────────────────────────────┘
```

Three containers either way:

- **`monerod`** — built from [`monero-project/monero`](https://github.com/monero-project/monero)
  source (`docker/monerod/Dockerfile`), run with the flags from the original
  spec (`--zmq-pub`, `--out-peers 32 --in-peers 64`, priority nodes, DNS
  checkpointing/blocklist, `--prune-blockchain` to save disk space).
- **`p2pool`** — built from [`SChernykh/p2pool`](https://github.com/SChernykh/p2pool)
  source (`docker/p2pool/Dockerfile`). Its `entrypoint.sh` reads your wallet
  address + pool mode from a small JSON file the dashboard writes, builds the
  right `p2pool --wallet ... [--mini|--nano] ...` command line, and
  **hot-restarts p2pool whenever you change Settings** — you never touch
  Docker.
- **the dashboard** (`app/`) — reads `monerod`'s RPC for sync status, reads
  the JSON files p2pool writes via `--data-api`/`--local-api`/`--stratum-api`
  for pool stats, and tails p2pool's log for block-found/share events (see
  [How stats are collected](#how-stats-are-collected) below for the honest
  details/limitations here).

## Quick start — plain Docker Compose

```bash
git clone https://github.com/your-github-username/monero-p2pool-dashboard
cd monero-p2pool-dashboard
docker compose up -d --build
```

Then open `http://<host>:3000`, go to **Settings**, paste your Monero primary
wallet address (starts with `4`), pick a pool mode, and save. Watch the
**Main** tab until sync finishes (hours to a couple of days for a first
sync), then grab your stratum URL from the **Pool** tab.

## Quick start — Umbrel / 5tratumOS app store install

Unlike the Compose file above, an installed Umbrel/5tratumOS app pulls
prebuilt images rather than building on-device, so there's a one-time
publishing step:

1. **Rename the app folder and fix placeholders.** `yourstore-monero-p2pool/`
   and `umbrel-app-store.yml`'s `id: yourstore` are placeholders — pick your
   own store id, rename the folder to `<your-id>-monero-p2pool`, and update
   `id:` inside `yourstore-monero-p2pool/umbrel-app.yml` to match. Replace
   every `your-github-username` in both `umbrel-app.yml` and
   `docker-compose.yml` under that folder with wherever you'll host images
   (see next step).
2. **Publish the three images.** Push a tag (`git tag v1.0.0 && git push
   --tags`) to trigger `.github/workflows/publish-images.yml`, which builds
   and pushes `app`, `p2pool`, and `monerod` to GHCR. Read that workflow's
   header comment first — it only builds `linux/amd64` by default; arm64
   (Raspberry Pi) needs extra work explained there. Once published, pin each
   `image:` line in `yourstore-monero-p2pool/docker-compose.yml` to
   `@sha256:<digest>`, the way Umbrel's own apps do.
3. **Add your store.** On the device: `Settings → App Stores → Add store`,
   paste this repo's URL. (5tratumOS's own README documents the same flow
   for its AxeSuite stores, and the underlying mechanism —
   `~/umbrel/scripts/repo add <url>` — is identical to plain umbrelOS.)
4. Install "Monero Node + P2Pool" from the store, then configure it the same
   way as the Compose path: Settings tab → wallet address + pool mode.

If you'd rather not maintain your own store, `WillItMod/umbrel-community-store`
(linked from the AxeSuite repo) is the existing home for that author's app
family — reach out there if you want this considered for inclusion; that's
their call to make, not something this repo can pre-decide.

## Ports

| Port | Service | Purpose | Forward on router? |
|---|---|---|---|
| 18080 | monerod | Monero p2p | Yes, improves connectivity |
| 18081 | monerod | RPC | No — internal only |
| 18083 | monerod | ZMQ | No — internal only |
| 3333 | p2pool | Stratum (miners connect here) | Only if mining from outside your LAN |
| 37889 | p2pool | P2Pool p2p (Standard) | Yes, improves connectivity |
| 37888 | p2pool | P2Pool p2p (Mini) | Yes, improves connectivity |
| 37890 | p2pool | P2Pool p2p (Nano) | Yes, improves connectivity |
| 3000 | dashboard | The dashboard | No — access via your Umbrel/5tratumOS UI or LAN |

## A note on build time

`docker/monerod/Dockerfile` compiles Monero from source, which can take
**well over an hour** and a few GB of RAM on modest hardware. If that's not
acceptable, swap in `docker/monerod/Dockerfile.prebuilt`, which downloads and
SHA256-verifies the official signed release binary instead (see the comment
at the top of that file for how to point either compose file at it). Either
way you get the identical `monerod` binary — this just trades build time for
trusting upstream's release process instead of your own compiler.

`docker/p2pool/Dockerfile`'s source build is much faster (a few minutes).

Both Dockerfiles track a moving branch (`release-v0.18` for Monero, `master`
for P2Pool) by default so you always build current code. Pin `MONERO_REF` /
`P2POOL_REF` build args to an exact tag for reproducible builds — and keep an
eye on [P2Pool's release page](https://github.com/SChernykh/p2pool/releases)
in particular, since P2Pool has shipped at least one critical security
update before; running an outdated P2Pool is a real financial risk, not just
a missed feature.

## How stats are collected (and current limitations)

Being upfront about what's solid vs. best-effort, since P2Pool's tooling
ecosystem isn't as thoroughly documented as Monero's own RPC:

- **Sync/hashrate/difficulty (Main tab)** come from `monerod`'s standard
  `/get_info` REST endpoint and p2pool's `local/stratum` JSON file — both
  well-established.
- **Pool tab's hashrate windows**: P2Pool's local API currently only reports
  15-minute/1-hour/24-hour windows. The spec asked for 1m/5m/15m/1h/6h/24h/7d;
  the ones P2Pool doesn't provide render as "—" rather than being faked.
  `app/lib/p2poolApi.js` documents the exact JSON fields read.
- **Blocks found + per-worker detail**: P2Pool's JSON API doesn't expose
  either of these, so `app/lib/blocks.js` tails p2pool's own log output for
  `BLOCK FOUND` / `SHARE FOUND` lines instead. This works, but log wording
  can change between P2Pool releases — if blocks or workers stop appearing
  after an update, run `docker compose logs p2pool | grep -i found` and
  adjust the regexes at the top of `app/lib/blocks.js` to match. This is
  called out loudly in that file's comments too.
- **"Best share" difficulty**: P2Pool doesn't have a literal
  "current best share" field distinct from stratum effort; the Main/Pool
  tabs use `current_effort`/`average_effort` from `local/stratum` as the
  closest available proxy. If you have a p2pool version with different
  field names, check `docker exec <p2pool-container> ls -la /data/p2pool-api`
  and update `app/lib/p2poolApi.js` accordingly.

None of this affects mining or payouts — it only affects what the dashboard
can *show*. P2Pool itself doesn't rely on any of this JSON API to function.

## Block explorer

The Blocks tab links out to [xmrchain.net](https://xmrchain.net) by default
(`EXPLORER_BASE_URL` in either compose file) so you can verify a found
block's payout against your address. The original spec asked specifically
for an **onion** Monero blockchain explorer. No .onion address is hardcoded
here — pasting one in from memory risked shipping a stale or wrong address —
but you can point `EXPLORER_BASE_URL` at whichever onion explorer you trust,
routed through a Tor proxy in your environment (Umbrel and 5tratumOS both
already run Tor for other apps; wire this container's outbound traffic
through it the same way).

## Repo layout

```
docker-compose.yml                          # plain Docker Compose stack (builds from source)
umbrel-app-store.yml                        # Umbrel/5tratumOS community store manifest (top level)
yourstore-monero-p2pool/                    # the actual installable app (rename this)
  umbrel-app.yml                              # app listing metadata
  docker-compose.yml                          # same 3 services, but pulls published images
docker/monerod/                              # from-source monerod build (+ prebuilt-binary alternative)
docker/p2pool/                               # from-source p2pool build + hot-reload entrypoint.sh
.github/workflows/
  build.yml                                    # CI: sanity-builds all 3 images on every push
  publish-images.yml                            # CI: publishes images to GHCR on a version tag
app/                                          # the dashboard
  server.js                                     # Express API
  lib/config.js                                  # Settings persistence (wallet address, pool mode)
  lib/moneroRpc.js                                # monerod RPC client
  lib/p2poolApi.js                                 # reads p2pool's --data-api JSON files
  lib/blocks.js                                     # tails p2pool's log for blocks/workers
  public/                                            # frontend (vanilla HTML/CSS/JS, Monero-GUI-style dark+orange theme)
```

## Security notes

- `monerod`'s RPC (18081) and ZMQ (18083) ports are **not** published to the
  host in either compose file — only reachable from other containers on the
  stack's internal Docker network. Keep it that way; an open RPC port is a
  real attack surface.
- Wallet addresses are public once you mine with them on P2Pool by design
  (this is inherent to how P2Pool works, not something this dashboard adds).
  Consider using a wallet you don't reuse elsewhere, per P2Pool's own
  recommendation.
- The Settings API (`POST /api/settings`) is unauthenticated at the network
  level — it's meant to sit behind Umbrel/5tratumOS's own access controls
  (Tor-only by default, LAN-only otherwise) or, for the plain Compose path,
  your own reverse proxy/firewall. Don't expose port 3000 directly to the
  public internet.
