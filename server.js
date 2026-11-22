'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const auth = require('./auth');
const bot = require('./bot');

const BASE = (process.env.FM_BASE_URL || 'https://freemodel.in/v1').replace(/\/+$/, '');
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 60 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function getKeys() {
  const found = [];
  for (let i = 1; i <= 100; i++) {
    const names = i === 1 ? ['FM_API_KEY'] : [`FM_API_KEY_${i}`, `FM_API_KEY${i}`];
    const value = names.map(n => process.env[n]).find(v => v && v.trim());
    if (value) found.push({ slot: i, value: value.trim() });
  }
  return found;
}
const retryable = s => [401, 402, 403, 408, 425, 429, 500, 502, 503, 504].includes(s);

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

// simple rate limits
const hits = new Map(), loginFails = new Map();
setInterval(() => hits.clear(), 60000).unref();
setInterval(() => loginFails.clear(), 10 * 60000).unref();

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res, url) {
  const ip = clientIp(req);
  const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
  if (n > 120) return sendJson(res, 429, { error: { message: 'Too many requests, 1 minute ruko' } });
  const keys = getKeys();
  if (!keys.length) return sendJson(res, 500, { error: { message: 'Render Environment me FM_API_KEY set karo.' } });
  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    try { body = await readBody(req); } catch (e) { return sendJson(res, 413, { error: { message: e.message } }); }
  }
  const headers = {};
  for (const h of ['content-type', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
  const target = BASE + url.pathname.replace(/^\/api/, '') + url.search;
  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const up = await fetch(target, { method: req.method, headers: { ...headers, authorization: 'Bearer ' + key.value, 'x-api-key': key.value }, body: body && body.length ? body : undefined, redirect: 'manual' });
      if (retryable(up.status) && i < keys.length - 1) { console.warn(`[WEB] key slot ${key.slot} -> ${up.status}, trying next`); try { await up.body?.cancel(); } catch {} continue; }
      const out = { 'x-accel-buffering': 'no', 'x-fm-key-slot': String(key.slot) };
      for (const h of ['content-type', 'content-disposition', 'cache-control']) { const v = up.headers.get(h); if (v) out[h] = v; }
      res.writeHead(up.status, out);
      if (!up.body) return res.end();
      const stream = Readable.fromWeb(up.body);
      stream.on('error', () => res.end());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    } catch (e) { lastError = e; console.warn(`[WEB] key slot ${key.slot} failed: ${e.message}`); }
  }
  sendJson(res, 502, { error: { message: 'All FM API keys failed. Keys aur FM_BASE_URL check karo.', details: lastError ? lastError.message : 'Provider rejected all keys.' } });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const token = req.headers['x-session-token'] || '';
    const ip = clientIp(req);

    if (p === '/api/health') return sendJson(res, 200, { status: 'ok' });

    if (p === '/api/info') {
      const keys = getKeys();
      return sendJson(res, 200, { needsPassword: true, hasKey: keys.length > 0, keysConfigured: keys.length, fallbackEnabled: keys.length > 1 });
    }
    if (p === '/api/session') return sendJson(res, 200, { ok: auth.webCheck(token, ip) });

    if (p === '/api/login' && req.method === 'POST') {
      if ((loginFails.get(ip) || 0) >= 10) return sendJson(res, 429, { ok: false, error: 'Bahut galat attempts. 10 minute baad try karo.' });
      let data = {};
      try { data = JSON.parse((await readBody(req, 10000)).toString() || '{}'); } catch {}
      const r = auth.webLogin(data.password, ip);
      if (!r.ok) loginFails.set(ip, (loginFails.get(ip) || 0) + 1);
      return sendJson(res, r.ok ? 200 : 401, r);
    }
    if (p === '/api/logout' && req.method === 'POST') { auth.webLogout(token); return sendJson(res, 200, { ok: true }); }

    if (p === '/bot-status') return sendJson(res, 200, bot.status());

    if (p.startsWith('/api/') || p === '/api') {
      if (!auth.webCheck(token, ip)) return sendJson(res, 401, { error: { message: 'Login required' } });
      return proxy(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[WEB] handler error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: 'Server error' } }); else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 65000;

(async () => {
  await auth.load();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[NEBULA WEB] listening on', PORT);
    bot.start({ getKeys, BASE, auth });
  });
  // Keep free Render instance awake (bot needs the process alive). Also add an external pinger (UptimeRobot) to /api/health.
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => fetch(self + '/api/health').catch(() => {}), 10 * 60 * 1000).unref();
})();
