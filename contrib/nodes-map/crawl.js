#!/usr/bin/env node
// BLAKE2b nodes registry: probes the addresses our node knows that advertise the
// BLAKE2B service bit (and the peers we are connected to), does a P2P version
// handshake, and keeps a light registry with GeoIP (local DB-IP Lite database).
// Writes data/registry.json (full registry) and data/public.json (what the map shows).
'use strict';
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Reader } = require('mmdb-lib');

const DIR = __dirname;
const DATA = process.env.NODES_MAP_DATA_DIR || path.join(DIR, 'data');
const REG = path.join(DATA, 'registry.json');
const PUB = path.join(DATA, 'public.json');
const GEOIP = process.env.NODES_MAP_GEOIP || path.join(DATA, 'dbip.mmdb');
const MAGIC = Buffer.from('f9beb4d9', 'hex');
const BIT_BLAKE2B = 1n << 28n;
const FORK_HEIGHT = 961640;
// Tor SOCKS proxy for onion addresses: TOR_PROXY=host:port, or "none" to skip onions.
const TOR = (() => {
  const v = process.env.TOR_PROXY ?? '127.0.0.1:9050';
  if (!v || v === 'none') return null;
  const i = v.lastIndexOf(':');
  return { host: v.slice(0, i), port: Number(v.slice(i + 1)) };
})();
const FORGET_DAYS = 30;

// How to ask the node. Two ways:
// - JSON-RPC (packages): BITCOIN_RPC_URL=http://host:port/ plus either BITCOIN_RPC_USER and
//   BITCOIN_RPC_PASSWORD, or BITCOIN_RPC_COOKIE=/path/to/.cookie.
// - bitcoin-cli (our own deploy, the default): BITCOIN_CLI (binary) and BITCOIN_DATADIR.
const RPC_URL = process.env.BITCOIN_RPC_URL;
const CLI = [process.env.BITCOIN_CLI || 'bitcoin-cli', ...(process.env.BITCOIN_DATADIR ? [`-datadir=${process.env.BITCOIN_DATADIR}`] : [])];

function rpcAuth() {
  if (process.env.BITCOIN_RPC_COOKIE) return fs.readFileSync(process.env.BITCOIN_RPC_COOKIE, 'utf8').trim();
  return `${process.env.BITCOIN_RPC_USER || ''}:${process.env.BITCOIN_RPC_PASSWORD || ''}`;
}

function rpc(method, params) {
  const u = new URL(RPC_URL);
  const body = JSON.stringify({ jsonrpc: '1.0', id: 'nodes-map', method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port || 8332, path: u.pathname || '/', method: 'POST',
      auth: rpcAuth(), headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let r;
        try { r = JSON.parse(text); } catch { return reject(new Error(`RPC ${method}: HTTP ${res.statusCode} ${text.slice(0, 200)}`)); }
        if (r.error) return reject(new Error(`RPC ${method}: ${r.error.message}`));
        resolve(r.result);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`RPC ${method}: timeout`)));
    req.on('error', reject);
    req.end(body);
  });
}

// Same calls either way; numeric arguments are passed as numbers over RPC.
const cli = async (method, ...a) => RPC_URL
  ? rpc(method, a.map((x) => (/^\d+$/.test(x) ? Number(x) : x)))
  : JSON.parse(execFileSync(CLI[0], [...CLI.slice(1), method, ...a], { maxBuffer: 1 << 28 }).toString());
const sha256d = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();

function msg(cmd, payload) {
  const h = Buffer.alloc(24);
  MAGIC.copy(h, 0);
  h.write(cmd, 4, 'ascii');
  h.writeUInt32LE(payload.length, 16);
  sha256d(payload).copy(h, 20, 0, 4);
  return Buffer.concat([h, payload]);
}

function versionPayload(height) {
  const ua = Buffer.from('/kilombino-nodes-map:0.1/');
  const p = Buffer.alloc(4 + 8 + 8 + 26 + 26 + 8 + 1 + ua.length + 4 + 1);
  let o = 0;
  p.writeInt32LE(70016, o); o += 4;
  p.writeBigUInt64LE(0n, o); o += 8; // we serve nothing
  p.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), o); o += 8;
  o += 26; // addr_recv (zeros are fine)
  o += 26; // addr_from
  crypto.randomBytes(8).copy(p, o); o += 8;
  p.writeUInt8(ua.length, o); o += 1;
  ua.copy(p, o); o += ua.length;
  p.writeInt32LE(height, o); o += 4;
  p.writeUInt8(0, o); // no tx relay
  return p;
}

function readVarInt(b, o) {
  const f = b[o];
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) return [b.readUInt16LE(o + 1), 3];
  if (f === 0xfe) return [b.readUInt32LE(o + 1), 5];
  return [Number(b.readBigUInt64LE(o + 1)), 9];
}

function parseVersion(p) {
  let o = 0;
  const version = p.readInt32LE(o); o += 4;
  const services = p.readBigUInt64LE(o); o += 8 + 8 + 26 + 26 + 8;
  const [len, n] = readVarInt(p, o); o += n;
  const ua = p.slice(o, o + len).toString('utf8').replace(/[^\x20-\x7e]/g, '');
  o += len;
  const height = p.length >= o + 4 ? p.readInt32LE(o) : null;
  return { version, services, ua, height };
}

function socksConnect(sock, host, port) {
  return new Promise((resolve, reject) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[1] !== 0) return reject(new Error('socks auth'));
        buf = buf.slice(2); stage = 1;
        const h = Buffer.from(host);
        const req = Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]);
        sock.write(req);
      }
      if (stage === 1 && buf.length >= 10) {
        sock.removeListener('data', onData);
        if (buf[1] !== 0) return reject(new Error('socks ' + buf[1]));
        resolve();
      }
    };
    sock.on('data', onData);
    sock.write(Buffer.from([5, 1, 0]));
  });
}

function probe(addr, height) {
  const tor = addr.network === 'onion';
  if (tor && !TOR) return Promise.resolve({ ok: false, err: 'no tor' });
  const timeout = tor ? 45000 : 10000;
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (r) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
    const sock = tor ? net.connect(TOR.port, TOR.host) : net.connect({ host: addr.address, port: addr.port, family: addr.network === 'ipv6' ? 6 : 4 });
    sock.setTimeout(timeout, () => finish({ ok: false, err: 'timeout' }));
    sock.on('error', (e) => finish({ ok: false, err: e.code || e.message }));
    sock.on('close', () => finish({ ok: false, err: 'closed' }));
    const start = async () => {
      try {
        if (tor) await socksConnect(sock, addr.address, addr.port);
      } catch (e) { return finish({ ok: false, err: e.message }); }
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 24) {
          if (!buf.slice(0, 4).equals(MAGIC)) return finish({ ok: false, err: 'magic' });
          const len = buf.readUInt32LE(16);
          if (buf.length < 24 + len) return;
          const cmd = buf.slice(4, 16).toString('ascii').replace(/\0+$/, '');
          const pl = buf.slice(24, 24 + len);
          buf = buf.slice(24 + len);
          if (cmd === 'version') {
            try { return finish({ ok: true, ...parseVersion(pl) }); } catch (e) { return finish({ ok: false, err: 'parse' }); }
          }
        }
      });
      sock.write(msg('version', versionPayload(height)));
    };
    sock.on('connect', start);
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

function geo(reader, ip) {
  try {
    const r = reader.get(ip);
    if (!r || !r.location) return null;
    return {
      lat: Math.round(r.location.latitude * 10) / 10,
      lon: Math.round(r.location.longitude * 10) / 10,
      city: r.city?.names?.en || null,
      country: r.country?.names?.en || null,
      cc: r.country?.iso_code || null,
    };
  } catch { return null; }
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const reg = fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG)) : { nodes: {} };
  fs.mkdirSync(DATA, { recursive: true });
  const tip = await cli('getblockcount');
  const reader = new Reader(fs.readFileSync(GEOIP));

  // Candidates: known addresses with the BLAKE2B bit, plus our outbound peers.
  const cands = new Map();
  for (const a of await cli('getnodeaddresses', '0')) {
    if (a.network === 'onion' && !TOR) continue;
    if (!['ipv4', 'ipv6', 'onion'].includes(a.network)) continue;
    if (!(BigInt(a.services) & BIT_BLAKE2B)) continue;
    cands.set(`${a.address}|${a.port}`, { address: a.address, port: a.port, network: a.network });
  }
  for (const k of Object.keys(reg.nodes)) {
    const n = reg.nodes[k];
    if (n.port && !cands.has(k) && (n.network !== 'onion' || TOR)) cands.set(k, { address: n.address, port: n.port, network: n.network });
  }

  // Peers connected right now (inbound ones too: they are nodes we met, even if not listening).
  const peers = await cli('getpeerinfo');
  for (const p of peers) {
    const m = p.addr.match(/^\[?(.+?)\]?:(\d+)$/);
    if (!m) continue;
    const [, address, port] = m;
    const network = p.network === 'not_publicly_routable' ? null : p.network;
    if (!network || !['ipv4', 'ipv6', 'onion'].includes(network)) continue;
    const blake = (BigInt('0x' + p.services) & BIT_BLAKE2B) !== 0n;
    const key = p.inbound ? `${address}|in` : `${address}|${port}`;
    const n = reg.nodes[key] || { address, port: p.inbound ? null : Number(port), network, first_seen: now };
    Object.assign(n, { ua: p.subver, height: p.startingheight, blake2b: blake, last_seen: now, peer: true, inbound: p.inbound });
    reg.nodes[key] = n;
  }

  const list = [...cands.entries()];
  const clear = list.filter(([, a]) => a.network !== 'onion');
  const onion = list.filter(([, a]) => a.network === 'onion');
  let ok = 0;
  const handle = async ([key, a]) => {
    const r = await probe(a, tip);
    const n = reg.nodes[key] || { ...a, first_seen: now };
    n.last_try = now;
    if (r.ok) {
      ok++;
      Object.assign(n, { ua: r.ua, height: r.height, version: r.version, blake2b: (r.services & BIT_BLAKE2B) !== 0n, last_seen: now, reachable: true, err: null });
    } else {
      n.reachable = false; n.err = r.err;
    }
    // Keep only nodes that answered at least once (or are/were our peers).
    if (n.last_seen) reg.nodes[key] = n; else delete reg.nodes[key];
  };
  await Promise.all([pool(clear, 64, handle), pool(onion, 12, handle)]);

  // Forget nodes not seen for FORGET_DAYS.
  for (const [k, n] of Object.entries(reg.nodes)) if (now - n.last_seen > FORGET_DAYS * 86400) delete reg.nodes[k];

  // Chain: BLAKE2B bit and a height on our side of the fork (the majority chain is far ahead).
  const pub = [];
  for (const n of Object.values(reg.nodes)) {
    n.chain = n.blake2b && n.height >= FORK_HEIGHT && n.height <= tip + 10 ? 'blake2b' : 'other';
    if (n.network !== 'onion' && !n.geo) n.geo = geo(reader, n.address);
    if (n.chain !== 'blake2b') continue;
    pub.push({
      address: n.address,
      port: n.port,
      network: n.network,
      ua: n.ua,
      height: n.height,
      status: n.reachable && now - n.last_seen < 2 * 3600 ? 'reachable' : (n.peer && now - n.last_seen < 2 * 3600 ? 'peer' : 'seen'),
      first_seen: n.first_seen,
      last_seen: n.last_seen,
      geo: n.geo || null,
    });
  }
  reg.updated = now;
  reg.tip = tip;
  fs.writeFileSync(REG + '.tmp', JSON.stringify(reg));
  fs.renameSync(REG + '.tmp', REG);
  const stats = {
    updated: now, tip, probed: list.length, answered: ok,
    blake2b: pub.length,
    reachable: pub.filter((x) => x.status === 'reachable').length,
    by_network: pub.reduce((m, x) => ((m[x.network] = (m[x.network] || 0) + 1), m), {}),
  };
  fs.writeFileSync(PUB + '.tmp', JSON.stringify({ stats, nodes: pub }));
  fs.renameSync(PUB + '.tmp', PUB);
  console.log(JSON.stringify(stats));
})().catch((e) => { console.error(e); process.exit(1); });
