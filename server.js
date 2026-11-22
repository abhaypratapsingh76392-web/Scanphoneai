const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '60mb' }));

const BASE = (process.env.FM_BASE_URL || 'https://freemodel.in/v1').replace(/\/+$/, '');
const PASS = process.env.APP_PASSWORD || '';
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();

function getKeys() {
  const found = [];
  // Supports FM_API_KEY, FM_API_KEY_2, FM_API_KEY_3 ... with no fixed limit.
  // Also accepts FM_API_KEY2 as a convenience alias.
  for (let i = 1; i <= 100; i++) {
    const names = i === 1
      ? ['FM_API_KEY']
      : [`FM_API_KEY_${i}`, `FM_API_KEY${i}`];
    const value = names.map(n => process.env[n]).find(v => v && v.trim());
    if (value) found.push({ slot: i, value: value.trim() });
  }
  return found;
}

function limited(req) {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  return n > 60;
}

function retryable(status) {
  // Do not retry ordinary request/model errors such as 400, 404 or 422.
  return [401, 403, 402, 408, 425, 429, 500, 502, 503, 504].includes(status);
}

app.get('/api/info', (req, res) => {
  const keys = getKeys();
  res.json({
    needsPassword: !!PASS,
    hasKey: keys.length > 0,
    keysConfigured: keys.length,
    fallbackEnabled: keys.length > 1
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', async (req, res) => {
  if (PASS && req.get('x-app-password') !== PASS) {
    return res.status(401).send('Wrong password');
  }
  if (limited(req)) return res.status(429).send('Too many requests, 1 minute ruko');

  const keys = getKeys();
  if (!keys.length) {
    return res.status(500).send('Render Environment me FM_API_KEY set karo. Backup keys: FM_API_KEY_2, FM_API_KEY_3 ...');
  }

  // Buffer the body once so the exact same request can be retried with another key.
  let body;
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.body && Object.keys(req.body).length) {
        body = Buffer.from(JSON.stringify(req.body));
      } else {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }
    }
  } catch (e) {
    return res.status(400).send('Request body read nahi ho paya: ' + e.message);
  }

  const headers = {};
  for (const h of ['content-type', 'accept']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  let lastError = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const h = {
      ...headers,
      authorization: 'Bearer ' + key.value,
      'x-api-key': key.value
    };
    const init = { method: req.method, headers: h, redirect: 'manual' };
    if (body && !['GET', 'HEAD'].includes(req.method)) init.body = body;

    try {
      const upstream = await fetch(BASE + req.url, init);

      if (retryable(upstream.status) && index < keys.length - 1) {
        console.warn(`FM key slot ${key.slot} returned ${upstream.status}; trying backup key slot ${keys[index + 1].slot}`);
        try { await upstream.body?.cancel(); } catch {}
        continue;
      }

      res.status(upstream.status);
      for (const hName of ['content-type', 'content-disposition', 'cache-control']) {
        const value = upstream.headers.get(hName);
        if (value) res.setHeader(hName, value);
      }
      res.setHeader('x-accel-buffering', 'no');
      res.setHeader('x-fm-key-slot', String(key.slot));
      res.setHeader('x-fm-fallback-count', String(index));
      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      lastError = e;
      console.warn(`FM key slot ${key.slot} request failed: ${e.message}`);
      if (index === keys.length - 1) break;
    }
  }

  res.status(502).json({
    error: {
      message: 'All configured FM API keys failed. Render Environment me keys aur FM_BASE_URL check karo.',
      details: lastError ? lastError.message : 'Provider rejected all configured keys.'
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));
function startTelegramBot() {
  if (!process.env.BOT_TOKEN || !process.env.BOT_TOKEN.trim()) {
    console.log('BOT_TOKEN not set; Telegram bot disabled.');
    return;
  }
  const py = process.env.PYTHON_BIN || 'python3';
  const child = spawn(py, [path.join(__dirname, 'bot.py')], {
    cwd: __dirname, env: process.env, stdio: ['ignore', 'inherit', 'inherit']
  });
  child.on('error', err => console.error('Telegram bot failed to start:', err.message));
  child.on('exit', (code, signal) => {
    console.error(`Telegram bot exited (code=${code}, signal=${signal}); restarting in 5s`);
    setTimeout(startTelegramBot, 5000).unref();
  });
}

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Nebula AI website running');
  startTelegramBot();
});
