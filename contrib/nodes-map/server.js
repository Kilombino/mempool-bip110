'use strict';
// Serves the Bitcoin Nodes World Map under /nodes-map/ (behind the Cloudflare tunnel of mempool.kilombino.com).
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 3110;
const PAGE = path.join(__dirname, 'public/index.html');
const DATA = path.join(__dirname, 'data/public.json');
http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/nodes-map') { res.writeHead(301, { Location: '/nodes-map/' }); return res.end(); }
  if (u === '/nodes-map/' || u === '/nodes-map/index.html' || u === '/nodes-map/embed') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=300', 'Content-Security-Policy': "frame-ancestors 'self'" });
    return fs.createReadStream(PAGE).pipe(res);
  }
  if (u === '/nodes-map/nodes.json') {
    fs.readFile(DATA, (e, b) => {
      if (e) { res.writeHead(503); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' });
      res.end(b);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1');
