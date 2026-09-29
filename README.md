# Triple X

**Status: Alpha (`v1.0-AlphaN`).** Past the numbered `Dev` builds now — the
app is feature-complete enough for wider testing, but still expect rough
edges. The on-screen version badge always shows exactly what's running.

A self-hosted Monero full node + [P2Pool](https://github.com/SChernykh/p2pool)
node, built from source, with optional Tari (XTM) merge-mining, Monero/Tari
wallet management, Discord webhook alerts, and a web dashboard for status,
pool stats, blocks found, and settings.

Payouts go straight to **your own wallet address** — there's no third party
pool operator and no custody of funds at any point. 0% fee, same as running
P2Pool directly.

## What's in here

| Tab | What it shows |
|---|---|
| **Overview** | Sync status/progress for both chains, hashrate, best share vs. network difficulty, and a readiness checklist (Node RPC, payout address, a proper 3-state blockchain sync indicator — *Not Running* / *Syncing* / *Synced* — and stratum) plus a network-ports panel. |
| **Pool** | Live stats for the P2Pool sidechain you're mining on (Standard/Mini/Nano): connected workers, hashrate over multiple windows, network difficulty/height, best share, per-worker detail, Tari (XTM) merge-mining status, and the miner connection info (stratum URL + payout address + setup instructions, including a note that P2Pool's stratum never actually checks the password field). |
| **Blocks** | Blocks your node's P2Pool sidechain has found, each linking to a block explorer so you can independently verify the payout landed on your address. |
| **Wallet** | Create, view balance for, send from, and recover (via seed phrase) both your Monero and Tari wallets, straight from the dashboard — no CLI needed. If a payout/merge-mining address is saved in Settings without ever creating a wallet here, the tab recognizes it as externally managed (a hardware wallet, exchange, etc.) and shows just the address instead of offering to create an unrelated one. |
| **Logs** | Live tail of the P2Pool log, optional per Settings. |
| **Settings** | Payout addresses, P2Pool mode (Standard / Mini / Nano, with a built-in "Which Pool Type Should I Use?" advisor), Discord webhook notifications, memory-usage tuning, and blockchain import — organized into collapsible sections so the tab stays short. Saving hot-restarts P2Pool with the new settings within ~10 seconds — no need to touch Docker. |

## Recent additions

- **5tratumOS app-store: dashboard port now published directly** — 5tratumOS
  runs no `app_proxy` container (unlike umbrelOS, which injects one per app
  from the environment stanza this app's compose file used to declare), so
  `web` now publishes port 3000 directly instead of relying on one to route
  to it. Compose-only fix, no image rebuild.
- **Efficiency pass** — settings and wallet-state files were being re-read
  and re-parsed from disk several times per poll tick (now cached in memory,
  invalidated by file mtime); the Tari blocks table was fetched as an extra
  sequential round-trip instead of alongside everything else; the Startup
  Checklist and Network Ports cards were torn down and rebuilt every 10s
  tick even when nothing changed (now skipped when unchanged); and the
  blocks/workers state file was rewritten to disk on nearly every poll
  during active mining instead of batched (now at most once/minute, except
  a found block still flushes immediately) - it also now prunes workers not
  seen in 90+ days so that file doesn't grow unbounded on a long-running
  install.
- **Tari merge-mining: fixed minotari-node getting stuck restarting forever** —
  two separate bugs, each capable of leaving the container crash-looping (and
  blocking the platform's own Stop button along with it): a comma-parsing
  bug in the gRPC method allow-list caused an instant crash on every start,
  and (once fixed) the `--init` flag turned out to mean "write default
  config and exit" rather than "bootstrap then keep running" - it exited
  clean every time and `restart:on-failure` just relaunched it into the same
  exit forever. Confirmed fixed live: the node now reaches "Minotari base
  node has STARTED" and stays up.
- **Import Blockchain: Windows drive-path fix + visible progress percent** —
  a remote path typed as a Windows drive letter (`F:\folder\subfolder`) was
  silently misread as relative by a Cygwin-based rsync install (`rsync
  exited with code 12/23`); it's now auto-converted to the Cygwin form
  (`/cygdrive/f/folder/subfolder`) rsync actually expects. The progress bar
  also now shows the transfer percentage as text underneath it.
- **Entered Alpha** — versioning moved from the numbered `v0.0.1-DevN` builds
  to `v1.0-AlphaN`. Also fixed the on-screen version badge, which had been
  hardcoded to "Dev1" since the very first build and silently never bumped
  through Dev2–Dev11 regardless of what was actually running.
- **Wallet tab recognizes externally-managed addresses** — if a payout/
  merge-mining address is saved in Settings without ever clicking Create
  Wallet, that address belongs to a wallet this dashboard has no keys for.
  The Wallet tab now shows a dedicated card for it (address only, no
  Balance/Send/Seed Phrase sections) instead of offering to create an
  unrelated wallet with no connection to the address actually receiving
  payouts.
- **Import Blockchain SSH fixes** — the rsync transfer was failing against
  Windows' bundled OpenSSH Server two different ways: a post-quantum KEX
  mismatch causing "Connection reset" on any auth method, and (once that was
  fixed) `BatchMode=yes` silently disabling the password prompt `sshpass`
  needs, breaking password auth specifically. Both fixed; key- and
  password-based auth against a Windows SSH source now work.
- **Light mode toned down** — panels were pure `#ffffff` against a near-white
  background, which read as glaringly bright next to the app's orange accent
  and dark-mode-tuned glow effects. Panels are now an off-white across all
  three color themes (Classic, Tari, Molten), with `bg`/`border` a shade
  darker so there's still visible depth between surfaces.
- **Discord webhook notifications** (`app/lib/discordNotify.js`) — get pinged
  in a Discord channel when a Monero block, a Tari block, or (optionally,
  off by default) a P2Pool share is found. Nothing is ever sent until you
  paste a webhook URL into Settings; a "Send Test Notification" button
  confirms it's wired up correctly before you rely on it.
- **Wallet tab** — create a fresh Monero or Tari wallet, check balance, send
  funds, and recover a wallet from its seed phrase, all from the dashboard.
  The dashboard itself never holds funds; it talks to the bundled
  `monero-wallet-rpc` / Minotari wallet containers.
- **3-state blockchain sync readiness** — the Overview checklist now
  distinguishes "node isn't reachable yet" (red, *Not Running*) from "node is
  up but still catching up" (orange, *Syncing*) from "fully caught up" (green,
  *Synced*), instead of collapsing the first two into one red state.
- **Stratum password clarified** — confirmed directly from
  [P2Pool's stratum server source](https://github.com/SChernykh/p2pool/blob/master/src/stratum_server.cpp)
  that the password field is never parsed at all, so the Miner Configuration
  panel now says so instead of leaving miners guessing what to put there.
- **Pool-type advisor** — a "Which Pool Type Should I Use?" panel in Settings
  explains Standard/Mini/Nano PPLNS window sizes (6h / 6h / 18h, from P2Pool's
  own sidechain constants) and links to P2Pool's live Average Share Time
  Calculator for hashrate-specific guidance, rather than hardcoding
  recommendations that aren't fixed protocol constants.
- **Condensed Settings tab** — Discord Notifications, the pool-type advisor,
  and the P2Pool memory-usage flags are now collapsed by default
  (native `<details>` sections) so the tab doesn't dominate the screen; core
  fields (addresses, pool type, Save button) stay always visible.

## Platforms

This repo doubles as two things:

1. **A plain Docker Compose stack** (`docker-compose.yml` at the repo root) —
   builds everything from source locally. Works anywhere Docker Compose runs.
2. **An Umbrel / 5tratumOS Community App Store** (`umbrel-app-store.yml` +
   `TripleX-triple-x/`) — installable through the App Stores UI on
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

Core containers either way (plus two more when Tari merge-mining is set up —
`minotari-node` and `minotari-wallet`, the latter built from source like the
others, the former using Tari's own official image):

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
git clone https://github.com/SIlver765/Triple-X
cd Triple-X
docker compose up -d --build
```

Then open `http://<host>:3000`, go to **Settings**, paste your Monero primary
wallet address (starts with `4`), pick a pool mode, and save. Watch the
**Overview** tab until sync finishes (hours to a couple of days for a first
sync), then grab your stratum URL from the **Pool** tab.

## Quick start — Umbrel / 5tratumOS app store install

Unlike the Compose file above, an installed Umbrel/5tratumOS app pulls
prebuilt images rather than building on-device, so there's a one-time
publishing step:

1. **Rename the app folder and fix placeholders.** `TripleX-triple-x/`
   and `umbrel-app-store.yml`'s `id: TripleX` are placeholders — pick your
   own store id, rename the folder to `<your-id>-monero-p2pool`, and update
   `id:` inside `TripleX-triple-x/umbrel-app.yml` to match. Replace
   every `SIlver765` in both `umbrel-app.yml` and
   `docker-compose.yml` under that folder with wherever you'll host images
   (see next step).
2. **Publish the five images.** Push a version tag (e.g. `git tag
   v1.0-Alpha4 && git push origin v1.0-Alpha4`) to trigger
   `.github/workflows/publish-images.yml`, which builds and pushes `app`,
   `p2pool`, `monerod`, `monero-wallet-rpc`, and `minotari-wallet` to GHCR.
   Read that workflow's header comment first — it only builds `linux/amd64`
   by default; arm64 (Raspberry Pi) needs extra work explained there. Once
   published, pin each `image:` line in `TripleX-triple-x/docker-compose.yml`
   to `@sha256:<digest>`, the way Umbrel's own apps do, and bump
   `umbrel-app.yml`'s `version:` and the on-screen badge in
   `app/public/index.html` to match.
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

## Import Blockchain (SSH)

Settings tab's opt-in "Import Blockchain" feature rsyncs a pre-synced Monero
blockchain from a remote host over SSH, so `monerod` doesn't have to sync
from scratch. It shells out to the system `ssh`/`rsync`/`sshpass` binaries
against whatever host/username/auth you give it, so the **remote** machine
needs to actually be reachable and rsync-capable — a few gotchas we hit
getting this working against a Windows source machine:

- **Username** — use the login account you sign into that machine's Windows
  session with (run `whoami` there; use the part after the `\`). If you sign
  in with a Microsoft account, `whoami` shows `MicrosoftAccount\you@email.com`
  — try the part before the `@`, but Windows OpenSSH Server can be picky
  about Microsoft accounts, so a local Windows account is more reliable.
- **`rsync` must be installed on the remote host** — it's not part of Windows
  or its bundled OpenSSH Server. `rsync exited with code 12` /
  `'rsync' is not recognized as an internal or external command` means it's
  missing. Easiest fix on Windows: install
  [Chocolatey](https://chocolatey.org/install) (elevated PowerShell), then
  `choco install rsync -y`. Make sure it lands on the **system-wide** PATH
  (Chocolatey's default) since the SSH session's environment isn't the same
  as an interactive login shell.
- **KEX mismatch** — a "Connection reset" before any auth is attempted means
  the client and Windows' bundled OpenSSH Server couldn't agree on a key
  exchange algorithm (this app pins to classical algorithms to avoid it —
  see `app/lib/blockchainImport.js`). Nothing to do on your end; flagging in
  case you see it from a different SSH client while testing the source host
  manually.
- **Password auth silently not prompting** — if the connection gets past
  KEX (you'll see "Permanently added ... to known hosts" first) but still
  resets, that used to be caused by `BatchMode=yes` disabling SSH's password
  prompt entirely; fixed in `blockchainImport.js` by scoping it to key-based
  auth only.

## Repo layout

```
docker-compose.yml                          # plain Docker Compose stack (builds from source)
umbrel-app-store.yml                        # Umbrel/5tratumOS community store manifest (top level)
TripleX-triple-x/                    # the actual installable app (rename this)
  umbrel-app.yml                              # app listing metadata
  docker-compose.yml                          # same 3 services, but pulls published images
docker/monerod/                              # from-source monerod build (+ prebuilt-binary alternative)
docker/p2pool/                               # from-source p2pool build + hot-reload entrypoint.sh
.github/workflows/
  build.yml                                    # CI: sanity-builds all 3 images on every push
  publish-images.yml                            # CI: publishes images to GHCR on a version tag
app/                                          # the dashboard
  server.js                                     # Express API
  lib/config.js                                  # Settings persistence (wallet/Tari address, pool mode, Discord, flags)
  lib/moneroRpc.js                                # monerod RPC client
  lib/minotariRpc.js                               # Minotari (Tari) node RPC client
  lib/p2poolApi.js                                  # reads p2pool's --data-api JSON files
  lib/p2poolObserver.js                              # optional p2pool.observer network-wide stats (opt-in)
  lib/blocks.js                                       # tails p2pool's log for blocks/workers, fires Discord alerts
  lib/tariBlocks.js                                    # tails the Tari node's log for blocks found, fires Discord alerts
  lib/discordNotify.js                                  # sends/tests Discord webhook notifications
  lib/moneroWalletRpc.js                                 # monero-wallet-rpc client (Wallet tab)
  lib/moneroWalletState.js                                # tracks whether a Monero wallet has been created
  lib/minotariWalletRpc.js                                 # Minotari wallet RPC client (Wallet tab)
  lib/tariWallet.js                                         # Tari wallet create/balance/send
  lib/tariWalletRecovery.js                                  # Tari wallet recovery from seed phrase
  lib/blockchainImport.js                                     # opt-in: import a pre-synced blockchain (needs Docker socket)
  lib/dockerControl.js                                         # start/stop compose services (import + wallet recovery flows)
  lib/remoteBrowse.js                                           # browse a remote host over SSH (blockchain import source)
  lib/logs.js                                                    # Logs tab support
  public/                                                         # frontend (vanilla HTML/CSS/JS, Monero-GUI-style dark+orange theme)
    img/                                                            # UI image assets - see Credits below
```

## Credits

This dashboard's UI reuses image assets from official upstream projects
rather than drawing everything from scratch. Full credit to their original
authors:

| Asset(s) | Source | Project |
|---|---|---|
| `app/public/img/monero-icon.png` | Monero's official ["ghost" symbol](https://www.getmonero.org/press-kit/) | [The Monero Project](https://github.com/monero-project) |
| `app/public/img/xmr-verify.png`, `app/public/img/xmr-write-down.png`, `app/public/img/xmr-card-bg.png` | Icons/card background from the official Monero GUI wallet's asset pack | [`monero-project/monero-gui`](https://github.com/monero-project/monero-gui) (BSD-3-Clause) |
| `app/public/img/tari-icon.png` | Tari's official logo | [The Tari Project](https://github.com/tari-project) |
| `app/public/img/tari-card-bg-landscape.png` | Composed for this project using the Tari logo above | — |
| `app/public/img/app-icon.svg`, `TripleX-triple-x/icon.svg` | The app/favicon icon - Monero's ghost symbol (primary) with Tari's logo as a merge-mining badge, composed from the two assets above | — |

No trademark or endorsement by the Monero Project or the Tari Project is
implied — these are community-reused brand/UI assets from their own public
repositories, used here purely to keep the wallet cards visually consistent
with the coins they represent. If you're the rights holder for any of these
and would prefer a different treatment (or removal), please open an issue.

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
