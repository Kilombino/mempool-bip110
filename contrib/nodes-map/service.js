'use strict';
// Everything in one process, for the StartOS and Umbrel packages (our own deploy uses the
// systemd units in systemd/ instead): serves the page, keeps the DB-IP City Lite database
// up to date in the data directory, and runs crawl.js every CRAWL_INTERVAL seconds.
//
// Env: NODES_MAP_DATA_DIR (default ./data), NODES_MAP_PORT (3110), NODES_MAP_BIND (127.0.0.1),
// CRAWL_INTERVAL (3600), plus what crawl.js reads (BITCOIN_RPC_URL, BITCOIN_RPC_COOKIE or
// BITCOIN_RPC_USER/PASSWORD, TOR_PROXY=none to skip onions).
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { fork } = require('child_process');

const DATA = process.env.NODES_MAP_DATA_DIR || path.join(__dirname, 'data');
const GEOIP = path.join(DATA, 'dbip.mmdb');
const INTERVAL = Number(process.env.CRAWL_INTERVAL || 3600) * 1000;
process.env.NODES_MAP_DATA_DIR = DATA;
process.env.NODES_MAP_GEOIP = GEOIP;
fs.mkdirSync(DATA, { recursive: true });

require('./server.js');

const log = (...a) => console.log(new Date().toISOString(), ...a);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nodes-map' }, timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const tmp = dest + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(zlib.createGunzip()).on('error', reject).pipe(out).on('error', reject);
      out.on('finish', () => { fs.renameSync(tmp, dest); resolve(); });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// The free database is published monthly as dbip-city-lite-YYYY-MM.mmdb.gz; the current
// month's file may not be out yet early in the month, so fall back to the previous one.
async function updateGeoip() {
  const age = fs.existsSync(GEOIP) ? Date.now() - fs.statSync(GEOIP).mtimeMs : Infinity;
  if (age < 32 * 86400e3) return;
  const d = new Date();
  for (let back = 0; back < 3; back++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
    const ym = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = `https://download.db-ip.com/free/dbip-city-lite-${ym}.mmdb.gz`;
    try {
      log('GeoIP: downloading', url);
      await download(url, GEOIP);
      log('GeoIP: ok');
      return;
    } catch (e) { log('GeoIP:', url, e.message); }
  }
  if (!fs.existsSync(GEOIP)) log('GeoIP: no database yet; will retry next round');
}

function crawl() {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'crawl.js'), [], { stdio: 'inherit' });
    child.on('exit', (code) => { log('crawl finished, code', code); resolve(); });
  });
}

(async function loop() {
  for (;;) {
    try { await updateGeoip(); } catch (e) { log('GeoIP:', e.message); }
    if (fs.existsSync(GEOIP)) await crawl();
    await new Promise((r) => setTimeout(r, fs.existsSync(GEOIP) ? INTERVAL : 600e3));
  }
})();
