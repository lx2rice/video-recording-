#!/usr/bin/env node
/**
 * Two jobs, both optional:
 *
 *   1. Serve the app over http://localhost:8080 so you can try it without
 *      deploying anything (browsers treat localhost as a secure origin, so the
 *      microphone and screen capture work).
 *
 *   2. Act as a key-hiding proxy. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY
 *      in the environment, put this server's URL in the app's Settings → Proxy
 *      URL, and the keys stay here instead of on the phone.
 *
 *      POST /anthropic/v1/messages            → api.anthropic.com
 *      POST /openai/v1/chat/completions       → api.openai.com
 *      POST /openai/v1/audio/transcriptions   → api.openai.com
 *
 * No dependencies — Node 18+ only.
 *
 *   node server.js               # serve + proxy on :8080
 *   PORT=3000 node server.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const UPSTREAM = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

// Only these paths may be proxied, so the server can't be used as an open relay.
const ALLOWED = new Set([
  'anthropic:/v1/messages',
  'openai:/v1/chat/completions',
  'openai:/v1/responses',
  'openai:/v1/audio/transcriptions',
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, anthropic-version, anthropic-beta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function proxy(req, res, provider, rest) {
  const key = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${provider.toUpperCase()}_API_KEY is not set on the proxy.` } }));
    return;
  }
  if (!ALLOWED.has(`${provider}:${rest}`)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `This proxy does not forward ${rest}.` } }));
    return;
  }

  const headers = { accept: req.headers.accept || '*/*' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (provider === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  } else {
    headers.authorization = `Bearer ${key}`;
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM[provider]}${rest}`, {
      method: 'POST',
      headers,
      body: Readable.toWeb(req),
      duplex: 'half',
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream request failed: ${err.message}` } }));
    return;
  }

  const out = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
  cors(res, req);
  res.writeHead(upstream.status, out);
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
  else res.end();
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  if (req.method === 'OPTIONS') { cors(res, req); res.writeHead(204).end(); return; }

  const match = urlPath.match(/^\/(anthropic|openai)(\/.*)$/);
  if (match && req.method === 'POST') {
    proxy(req, res, match[1], match[2]).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405).end('Method not allowed'); return; }
  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  const keys = [
    process.env.ANTHROPIC_API_KEY ? 'Anthropic' : null,
    process.env.OPENAI_API_KEY ? 'OpenAI' : null,
  ].filter(Boolean);
  console.log(`ClipMind on http://localhost:${PORT}`);
  console.log(keys.length ? `Proxying with keys for: ${keys.join(', ')}` : 'No API keys set — the app will call the APIs directly from the browser.');
});
