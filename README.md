# Mempool — BIP110 edition

A self-hostable Bitcoin mempool explorer based on the **Retropex** fork of [mempool](https://github.com/mempool/mempool) (v3.4-dev), extended with:

- **BIP110 "Reduced Data Temporary Softfork" violation detection.** Blocks and transactions that would be *invalid* under the proposed BIP110 consensus rules are flagged:
  - ☢️ radioactive indicator + violation count on each block in the block list.
  - "BIP110 Violations" row on the block detail page.
  - Per-transaction badge with a tooltip explaining **which of the 7 rules** it breaks, and a warning banner on the transaction page.
  - All 7 rules per `bip-0110.mediawiki` (oversized scriptPubKey, large PUSHDATA/witness items, undefined witness versions, Taproot annex, large control blocks, OP_SUCCESS, OP_IF/NOTIF in tapscript).
- **BIP110 miner signaling** display (version bit 4) — inherited from Retropex.
- **Node distribution chart split by IPv4 / IPv6 / Tor** (Knots nodes), with network percentages computed from active nodes.

Violation detection logic ported from [paulscode/mempool-bip110](https://github.com/paulscode/mempool-bip110).

## Credits & license

- [mempool/mempool](https://github.com/mempool/mempool) — AGPL-3.0
- [Retropex/mempool](https://github.com/Retropex/mempool)
- [paulscode/mempool-bip110](https://github.com/paulscode/mempool-bip110)

Licensed under AGPL-3.0 (see `LICENSE`).

## Build (Docker, self-host)

```sh
# 1. Prepare the repo for Dockerization (copies Dockerfiles into backend/ and frontend/, downloads GeoIP data)
sh docker/init.sh

# 2. Build the backend (Rust gbt + Node)
docker buildx build \
  --tag mempoolbackend:bip110 \
  --build-context rustgbt=./rust \
  --build-context backend=./backend \
  --build-arg commitHash=bip110 \
  --load ./backend/

# 3. Build the frontend (Angular)
docker buildx build \
  --tag mempoolfrontend:bip110 \
  --build-arg commitHash=bip110 \
  --load ./frontend/
```

Then point a `docker-compose.yml` at your own Bitcoin node (Core/Knots RPC) and an Electrum server (Fulcrum / electrs), set the database, and run. See `docker/README.md` for full self-hosting instructions.

> Note: BIP110 violation counts populate for blocks summarised by this build. To backfill historical blocks, let the summaries indexer re-run (or re-summarise).

---

# The Mempool Open Source Project® [![mempool](https://img.shields.io/endpoint?url=https://dashboard.cypress.io/badge/simple/ry4br7/master&style=flat-square)](https://dashboard.cypress.io/projects/ry4br7/runs)

https://user-images.githubusercontent.com/93150691/226236121-375ea64f-b4a1-4cc0-8fad-a6fb33226840.mp4

<br>

Mempool is the fully-featured mempool visualizer, explorer, and API service running at [mempool.space](https://mempool.space/). 

It is an open-source project developed and operated for the benefit of the Bitcoin community, with a focus on the emerging transaction fee market that is evolving Bitcoin into a multi-layer ecosystem.

# Installation Methods

Mempool can be self-hosted on a wide variety of your own hardware, ranging from a simple one-click installation on a Raspberry Pi full-node distro all the way to a robust production instance on a powerful FreeBSD server. 

Most people should use a <a href="#one-click-installation">one-click install method</a>.

Other install methods are meant for developers and others with experience managing servers. If you want support for your own production instance of Mempool, or if you'd like to have your own instance of Mempool run by the mempool.space team on their own global ISP infrastructure—check out <a href="https://mempool.space/enterprise" target="_blank">Mempool Enterprise®</a>.

<a id="one-click-installation"></a>
## One-Click Installation

Mempool can be conveniently installed on the following full-node distros: 
- [Umbrel](https://github.com/getumbrel/umbrel)
- [RaspiBlitz](https://github.com/rootzoll/raspiblitz)
- [RoninDojo](https://code.samourai.io/ronindojo/RoninDojo)
- [myNode](https://github.com/mynodebtc/mynode)
- [StartOS](https://github.com/Start9Labs/start-os)
- [nix-bitcoin](https://github.com/fort-nix/nix-bitcoin/blob/a1eacce6768ca4894f365af8f79be5bbd594e1c3/examples/configuration.nix#L129)

**We highly recommend you deploy your own Mempool instance this way.** No matter which option you pick, you'll be able to get your own fully-sovereign instance of Mempool up quickly without needing to fiddle with any settings.

## Advanced Installation Methods

Mempool can be installed in other ways too, but we only recommend doing so if you're a developer, have experience managing servers, or otherwise know what you're doing.

- See the [`docker/`](./docker/) directory for instructions on deploying Mempool with Docker.
- See the [`backend/`](./backend/) and [`frontend/`](./frontend/) directories for manual install instructions oriented for developers.
- See the [`production/`](./production/) directory for guidance on setting up a more serious Mempool instance designed for high performance at scale.
