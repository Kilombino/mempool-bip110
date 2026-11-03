# Bitcoin Nodes World Map

A light registry of the nodes on the BLAKE2b chain that our node finds, shown on a world map
under `/nodes-map/` and embedded in the dashboard (`/nodes-map/embed`).

- `crawl.js` (hourly): takes every address the node knows (`getnodeaddresses 0`) that announces
  the `NODE_BLAKE2B` service bit (1 << 28), plus the peers it is connected to, and does a P2P
  `version` handshake with each (IPv4, IPv6, and onion through Tor at 127.0.0.1:9050). A node
  counts as being on this chain when it announces the bit and its height is between the fork
  (961640) and our tip. Nodes not seen for 30 days are dropped.
- Locations come from a local copy of the [DB-IP](https://db-ip.com) IP to City Lite database
  (CC BY 4.0), so no address is sent to any outside service. Put it at `data/dbip.mmdb`:
  `curl -L https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.mmdb.gz | gunzip > data/dbip.mmdb`.
- `server.js` serves the page and `nodes.json` on 127.0.0.1:3110. Route `/nodes-map/` of the
  explorer's hostname to it in front of the frontend (we use a Cloudflare tunnel ingress rule with
  the path `^/nodes-map(/.*)?$`).

Install: copy this directory to `~/nodes-map`, `npm install`, add the GeoIP file, then install the
units in `systemd/` as user units and enable `nodes-map-web.service` and `nodes-map-crawl.timer`.

## In the StartOS and Umbrel packages

`service.js` runs everything in one process: it serves the page, downloads the DB-IP database into
the data directory on first start (and again when it is a month old; the current month's file,
falling back to the previous month's), and runs `crawl.js` every hour. `Dockerfile` builds that
image. There `crawl.js` talks JSON-RPC to the user's node instead of running `bitcoin-cli`:

- `BITCOIN_RPC_URL=http://host:port/` and either `BITCOIN_RPC_COOKIE=/path/to/.cookie` or
  `BITCOIN_RPC_USER` + `BITCOIN_RPC_PASSWORD` (without `BITCOIN_RPC_URL` it uses `bitcoin-cli`
  as before);
- `TOR_PROXY=host:port` for onion addresses, or `none` to probe clearnet only (the image default);
- `NODES_MAP_DATA_DIR`, `NODES_MAP_PORT`, `NODES_MAP_BIND`, `CRAWL_INTERVAL` (seconds).

The frontend image routes `/nodes-map/` to it when `NODES_MAP_UPSTREAM` is set
(e.g. `http://127.0.0.1:3110`, see `docker/frontend/entrypoint.sh`).
