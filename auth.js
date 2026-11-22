'use strict';
// Nebula AI auth: admin-generated passwords, locked to first IP (web) / first Telegram ID (bot).
// Storage: Firebase Realtime DB (if FIREBASE_DB_URL set) so data survives Render restarts, else local file.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const FB_SECRET = (process.env.FIREBASE_SECRET || '').trim();
const FILE = process.env.AUTH_FILE || path.join(process.env.DATA_DIR || __dirname, 'auth-data.json');
const STRICT_IP = process.env.STRICT_SESSION_IP === '1';

let db = { passes: {}, sessions: {}, tgUsers: {} };
let saveTimer = null;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();

async function fbReq(method, body) {
  const url = FB_URL + '/nebula_auth.json' + (FB_SECRET ? '?auth=' + encodeURIComponent(FB_SECRET) : '');
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('Firebase HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function load() {
  try {
    let d = null;
    if (FB_URL) d = await fbReq('GET');
    else if (fs.existsSync(FILE)) d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && typeof d === 'object') db = { passes: d.passes || {}, sessions: d.sessions || {}, tgUsers: d.tgUsers || {} };
    console.log('[AUTH] Loaded. storage=' + (FB_URL ? 'firebase' : 'local file (resets on Render restart!)') + ' passes=' + Object.keys(db.passes).length);
  } catch (e) { console.error('[AUTH] load failed:', e.message); }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (FB_URL) await fbReq('PUT', db);
      else fs.writeFileSync(FILE, JSON.stringify(db));
    } catch (e) { console.error('[AUTH] save failed:', e.message); }
  }, 200);
}

function newPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += abc[crypto.randomInt(abc.length)];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8);
}
const norm = p => String(p || '').trim().replace(/\s+/g, '');

function createPass(label, byAdmin) {
  const password = newPassword();
  const id = crypto.randomBytes(3).toString('hex');
  db.passes[id] = { hash: sha(norm(password)), label: String(label || 'user').slice(0, 40), createdAt: now(), by: String(byAdmin), ip: null, tgId: null, active: true };
  save();
  return { id, password };
}
function findPass(password) {
  const h = sha(norm(password));
  return Object.entries(db.passes).find(([, p]) => p.hash === h && p.active) || null;
}
function listPasses() { return Object.entries(db.passes).map(([id, p]) => ({ id, ...p })); }
function revoke(id) {
  if (!db.passes[id]) return false;
  delete db.passes[id];
  for (const [t, s] of Object.entries(db.sessions)) if (s.passId === id) delete db.sessions[t];
  for (const [u, s] of Object.entries(db.tgUsers)) if (s.passId === id) delete db.tgUsers[u];
  save(); return true;
}
function resetBinding(id) {
  const p = db.passes[id]; if (!p) return false;
  p.ip = null; p.tgId = null;
  for (const [t, s] of Object.entries(db.sessions)) if (s.passId === id) delete db.sessions[t];
  for (const [u, s] of Object.entries(db.tgUsers)) if (s.passId === id) delete db.tgUsers[u];
  save(); return true;
}

// ---- Website login: first IP wins. Same password from another IP => rejected. ----
function webLogin(password, ip) {
  const f = findPass(password);
  if (!f) return { ok: false, error: 'Wrong password' };
  const [id, p] = f;
  if (!p.ip) { p.ip = ip; p.boundAt = now(); }
  else if (p.ip !== ip) return { ok: false, error: 'Ye password kisi aur IP/device pe lock hai. Admin se naya password lo.' };
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { passId: id, ip, at: now() };
  save();
  return { ok: true, token };
}
function webCheck(token, ip) {
  if (!token) return false;
  const s = db.sessions[sha(token)];
  if (!s) return false;
  const p = db.passes[s.passId];
  if (!p || !p.active) return false;
  if (STRICT_IP && s.ip !== ip) return false;
  return true;
}
function webLogout(token) { if (token && db.sessions[sha(token)]) { delete db.sessions[sha(token)]; save(); } }

// ---- Telegram login: first Telegram user ID wins (Telegram gives no IP). ----
function tgLogin(password, tgId) {
  const f = findPass(password);
  if (!f) return { ok: false, error: 'Wrong password.' };
  const [id, p] = f;
  if (!p.tgId) { p.tgId = String(tgId); p.tgBoundAt = now(); }
  else if (p.tgId !== String(tgId)) return { ok: false, error: 'Ye password kisi aur Telegram account pe lock hai.' };
  db.tgUsers[String(tgId)] = { passId: id, at: now() };
  save();
  return { ok: true };
}
function tgCheck(tgId) {
  const u = db.tgUsers[String(tgId)];
  if (!u) return false;
  const p = db.passes[u.passId];
  return !!(p && p.active && p.tgId === String(tgId));
}

module.exports = { load, createPass, listPasses, revoke, resetBinding, webLogin, webCheck, webLogout, tgLogin, tgCheck };
