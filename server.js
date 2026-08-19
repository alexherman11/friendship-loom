/* server.js — zero-dependency static host for Friendship Loom (Railway). */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad request');
  }
  const fp = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`friendship-loom serving on :${PORT}`);
});
