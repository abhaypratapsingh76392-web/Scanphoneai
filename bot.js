'use strict';
// Nebula AI Telegram bot (Node, no dependencies). Runs inside the same process as the website.
const crypto = require('crypto');
const zlib = require('zlib');

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const TG = (process.env.TG_API_BASE || 'https://api.telegram.org') + '/bot' + TOKEN;
const ADMINS = new Set((process.env.ADMIN_ID || process.env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean).map(String));
const MAX = 3900, PAGE = 12;

let ctx = null, started = false, botUser = null, lastPoll = 0;
const STATE = new Map();        // chat -> {model, history}
const MODEL_MAP = new Map();    // token -> model id
const MODEL_CACHE = { at: 0, items: [] };
const failCount = new Map();    // tgId -> {n, until}

const isAdmin = id => ADMINS.has(String(id));
const log = (...a) => console.log('[NEBULA BOT]', ...a);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Telegram ----------
async function tg(method, payload = {}, timeoutMs = 40000) {
  const r = await fetch(TG + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error(j.description || 'Telegram error ' + r.status); e.code = j.error_code; throw e; }
  return j.result;
}
const send = (chat, text, extra = {}) => tg('sendMessage', { chat_id: chat, text: String(text).slice(0, MAX), disable_web_page_preview: true, ...extra });
const edit = (chat, msg, text, extra = {}) => tg('editMessageText', { chat_id: chat, message_id: msg, text: String(text).slice(0, MAX), disable_web_page_preview: true, ...extra }).catch(() => {});
const answerCb = (id, text = '') => tg('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 180) }).catch(() => {});
async function sendDoc(chat, filename, buf, caption) {
  const f = new FormData();
  f.append('chat_id', String(chat)); f.append('caption', caption || '');
  f.append('document', new Blob([buf], { type: 'application/zip' }), filename);
  const r = await fetch(TG + '/sendDocument', { method: 'POST', body: f, signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'sendDocument failed');
}
async function splitSend(chat, text) {
  text = (text || '').trim() || '(Empty response)';
  while (text) {
    let chunk = text.slice(0, MAX);
    if (text.length > MAX) { const cut = chunk.lastIndexOf('\n'); if (cut > MAX / 2) chunk = text.slice(0, cut); }
    await send(chat, chunk);
    text = text.slice(chunk.length).replace(/^\s+/, '');
  }
}

// ---------- Provider ----------
async function provider(path, payload, timeoutMs = 120000) {
  const keys = ctx.getKeys();
  if (!keys.length) throw new Error('Render secret FM_API_KEY set nahi hai.');
  let last = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const r = await fetch(ctx.BASE + path, {
        method: payload ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + keys[i].value, 'x-api-key': keys[i].value, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await r.text();
      if (!r.ok) {
        last = `HTTP ${r.status}: ${text.slice(0, 300)}`;
        if ([401, 402, 403, 408, 425, 429, 500, 502, 503, 504].includes(r.status) && i < keys.length - 1) { log(`key slot ${keys[i].slot} -> ${r.status}, next`); continue; }
        break;
      }
      try { return JSON.parse(text); } catch { return { _text: text }; }
    } catch (e) { last = e.message; if (i === keys.length - 1) break; }
  }
  throw new Error('All FM API keys failed. ' + last);
}

async function getModels(force) {
  if (!force && MODEL_CACHE.items.length && Date.now() - MODEL_CACHE.at < 300000) return MODEL_CACHE.items;
  const data = await provider('/models', null, 30000);
  let items = Array.isArray(data) ? data : (data.data || data.models || data.results || []);
  if (items && !Array.isArray(items)) items = items.data || items.models || [];
  const out = [], seen = new Set();
  for (const m of Array.isArray(items) ? items : []) {
    let id, name;
    if (typeof m === 'string') { id = name = m; }
    else if (m && typeof m === 'object') {
      id = m.id || m.model || m.slug; if (!id) continue;
      const typ = String(m.type || m.capability || '').toLowerCase();
      if (/image-generation|text-to-image|text-to-video|embedding|speech|audio/.test(typ)) continue;
      name = m.name || m.display_name || id;
    } else continue;
    id = String(id); if (seen.has(id)) continue; seen.add(id); out.push({ id, name: String(name) });
  }
  if (!out.length) throw new Error('Provider /models se koi usable model nahi mila. FM_BASE_URL aur API key check karo.');
  MODEL_CACHE.at = Date.now(); MODEL_CACHE.items = out;
  return out;
}
async function modelKeyboard(page) {
  const models = await getModels();
  const start = page * PAGE, rows = [];
  for (let i = start; i < Math.min(start + PAGE, models.length); i += 2) {
    rows.push(models.slice(i, i + 2).map(m => {
      const t = crypto.createHash('sha1').update(m.id).digest('hex').slice(0, 12);
      MODEL_MAP.set(t, m.id);
      return { text: ('✦ ' + m.name).slice(0, 60), callback_data: 'm:' + t };
    }));
  }
  const nav = [];
  if (page > 0) nav.push({ text: '‹ Prev', callback_data: 'p:' + (page - 1) });
  if (start + PAGE < models.length) nav.push({ text: 'Next ›', callback_data: 'p:' + (page + 1) });
  if (nav.length) rows.push(nav);
  return { kb: { inline_keyboard: rows }, total: models.length };
}
async function modelPrompt(chat) {
  try {
    const { kb, total } = await modelKeyboard(0);
    await send(chat, `✦ <b>NEBULA AI MODEL STUDIO</b>\n\nAvailable chat models: ${total}\nChoose a model to start chatting.`, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) { console.error('[NEBULA BOT] model list failed:', e); await send(chat, '⚠️ Models load nahi hue.\n\n' + e.message.slice(0, 700)); }
}

// ---------- Zip (no dependency) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(entries) { // entries: [{name, data(Buffer)}]
  const locals = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.data, comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function extractFiles(text) {
  const cands = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1])];
  for (const c of cands) {
    const a = c.indexOf('{'), b = c.lastIndexOf('}'); if (a < 0 || b <= a) continue;
    let obj; try { obj = JSON.parse(c.slice(a, b + 1)); } catch { continue; }
    if (!obj || !Array.isArray(obj.files)) continue;
    const files = [];
    for (const f of obj.files.slice(0, 180)) {
      if (!f || typeof f !== 'object') continue;
      const p = String(f.path || f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!p || p.split('/').includes('..') || p.length > 180) continue;
      let content = f.content ?? f.code ?? ''; if (typeof content !== 'string') content = JSON.stringify(content, null, 2);
      files.push({ path: p, content });
    }
    if (files.length) return { project: String(obj.project_name || 'nebula-project'), files };
  }
  return { project: null, files: [] };
}

// ---------- AI chat ----------
const SYSTEM = 'You are Nebula AI, a helpful coding and general assistant. Reply clearly. When the user asks for a project containing multiple files, return a valid JSON object with keys project_name and files; files must be an array of objects with path and content. Do not put the JSON inside markdown fences. Include every required folder in file paths. For a request that needs only one file, provide that file\'s complete code in one fenced code block.';

async function askAI(chat, text) {
  const st = STATE.get(chat) || { model: null, history: [] }; STATE.set(chat, st);
  if (!st.model) return send(chat, 'Pehle /models se apna AI model select karo.');
  st.history.push({ role: 'user', content: text }); st.history = st.history.slice(-16);
  const status = await send(chat, '✦ Nebula is thinking…\n\n▰▱ Understanding your request\n▱▱ Generating response\n▱▱ Preparing files (if needed)');
  const typing = setInterval(() => tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {}), 4000);
  try {
    const data = await provider('/chat/completions', { model: st.model, messages: [{ role: 'system', content: SYSTEM }, ...st.history], stream: false });
    let ans = data?.choices?.[0]?.message?.content ?? data?._text ?? '';
    if (Array.isArray(ans)) ans = ans.map(x => x?.text || '').join('');
    ans = String(ans).trim();
    if (!ans) throw new Error('Model ne empty response diya.');
    const { project, files } = extractFiles(ans);
    if (files.length) {
      await edit(chat, status.message_id, `✦ Project ready\n\n✓ ${files.length} files created\n✓ ZIP prepared\n\nSending your project…`);
      const zip = makeZip(files.map(f => ({ name: project + '/' + f.path, data: Buffer.from(f.content, 'utf8') })));
      await sendDoc(chat, project.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60) + '.zip', zip, `✦ ${project}\n${files.length} files • Complete folder structure`);
      st.history.push({ role: 'assistant', content: `Created project ${project} with ${files.length} files.` });
    } else {
      await edit(chat, status.message_id, '✦ Response generated\n\n✓ Ready');
      await splitSend(chat, ans);
      st.history.push({ role: 'assistant', content: ans.slice(0, 12000) });
    }
    st.history = st.history.slice(-16);
  } catch (e) {
    console.error('[NEBULA BOT] ask failed:', e.message);
    await edit(chat, status.message_id, '⚠️ Request failed\n\n' + e.message.slice(0, 3000));
    if (st.history.at(-1)?.role === 'user') st.history.pop();
  } finally { clearInterval(typing); }
}

// ---------- Access control ----------
const allowed = id => isAdmin(id) || ctx.auth.tgCheck(id);

async function tryPassword(m) {
  const id = m.from.id, chat = m.chat.id;
  const f = failCount.get(id) || { n: 0, until: 0 };
  if (Date.now() < f.until) return send(chat, '⛔ Bahut galat attempts. Kuch der baad try karo.');
  const r = ctx.auth.tgLogin(m.text, id);
  tg('deleteMessage', { chat_id: chat, message_id: m.message_id }).catch(() => {}); // hide password from chat
  if (!r.ok) {
    f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0; } failCount.set(id, f);
    return send(chat, '❌ ' + r.error);
  }
  failCount.delete(id);
  await send(chat, '✅ Login successful. Ab aap permanently logged in ho.');
  await modelPrompt(chat);
}

async function adminCommand(chat, command, args) {
  if (command === '/newpass') {
    const label = args.join(' ') || 'user';
    const { id, password } = ctx.auth.createPass(label, chat);
    return send(chat, `✅ New password created\n\nLabel: ${esc(label)}\nID: <code>${id}</code>\nPassword: <code>${password}</code>\n\nYe password sirf ek hi user ke liye hai: website pe pehle IP se, bot pe pehle Telegram account se lock ho jayega.`, { parse_mode: 'HTML' });
  }
  if (command === '/passes') {
    const l = ctx.auth.listPasses();
    if (!l.length) return send(chat, 'Abhi koi password nahi hai. /newpass naam se banao.');
    return send(chat, l.map(p => `ID ${p.id} • ${p.label}\n  Web IP: ${p.ip || 'not used yet'}\n  Telegram: ${p.tgId || 'not used yet'}`).join('\n\n') + '\n\n/revoke ID — delete\n/resetip ID — lock reset');
  }
  if (command === '/revoke') { const id = args[0]; return send(chat, id && ctx.auth.revoke(id) ? '🗑 Password deleted, uske saare login band.' : 'Usage: /revoke ID (ID /passes me dekho)'); }
  if (command === '/resetip') { const id = args[0]; return send(chat, id && ctx.auth.resetBinding(id) ? '🔄 Lock reset. Password ab naye IP/Telegram account pe pehli baar use ho sakta hai.' : 'Usage: /resetip ID'); }
}

async function onMessage(m) {
  if (!m.from || m.chat.type !== 'private') return;
  const chat = m.chat.id, uid = m.from.id;
  const text = (m.text || m.caption || '').trim();
  const command = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : '';
  const args = text.split(/\s+/).slice(1);

  if (!allowed(uid)) {
    if (command === '/start' || !text || command) return send(chat, '🔐 <b>NEBULA AI</b>\n\nAccess password bhejo (admin se lo).', { parse_mode: 'HTML' });
    return tryPassword(m);
  }
  if (isAdmin(uid) && ['/newpass', '/passes', '/revoke', '/resetip'].includes(command)) return adminCommand(chat, command, args);
  if (!text) return send(chat, 'Abhi sirf text prompts supported hain.');
  if (command === '/start') {
    await send(chat, '✦ <b>NEBULA AI</b>\nYour AI chat & coding assistant.\n\nModel choose karo, phir koi bhi sawal bhejo. Multi-file project ZIP ke roop mein milega.\n\nCommands: /models /new /status /help' + (isAdmin(uid) ? '\nAdmin: /newpass /passes /revoke /resetip' : ''), { parse_mode: 'HTML' });
    return modelPrompt(chat);
  }
  if (command === '/help') return send(chat, 'Commands:\n/start\n/models — model choose\n/new — chat clear\n/status — bot/API status\n' + (isAdmin(uid) ? '\nAdmin:\n/newpass [naam] — naya password\n/passes — list\n/revoke ID — password delete\n/resetip ID — IP/Telegram lock reset' : ''));
  if (command === '/status') return send(chat, `✦ NEBULA STATUS\nBot: online (@${botUser})\nAPI keys: ${ctx.getKeys().length}\nAPI base: ${ctx.BASE}\nModel: ${STATE.get(chat)?.model || 'Not selected'}`);
  if (command === '/models') return modelPrompt(chat);
  if (command === '/new') { STATE.set(chat, { model: STATE.get(chat)?.model || null, history: [] }); return send(chat, 'New conversation started. Model retained.'); }
  if (command) return send(chat, 'Unknown command. /help dekho.');
  askAI(chat, text).catch(e => console.error('[NEBULA BOT] askAI crash:', e));
}

async function onCallback(c) {
  const chat = c.message.chat.id, msg = c.message.message_id, data = c.data || '';
  if (!allowed(c.from.id)) return answerCb(c.id, 'Pehle password se login karo.');
  await answerCb(c.id);
  if (data.startsWith('p:')) {
    try { const { kb, total } = await modelKeyboard(Math.max(0, parseInt(data.slice(2)) || 0)); await edit(chat, msg, `✦ NEBULA AI MODEL STUDIO\n\nAvailable chat models: ${total}\nChoose a model.`, { reply_markup: kb }); }
    catch (e) { await send(chat, e.message.slice(0, 500)); }
  } else if (data.startsWith('m:')) {
    const model = MODEL_MAP.get(data.slice(2));
    if (!model) { await send(chat, 'Model list expire ho gayi, /models dobara kholo.'); return modelPrompt(chat); }
    const st = STATE.get(chat) || { history: [] }; st.model = model; st.history = st.history || []; STATE.set(chat, st);
    await send(chat, `✓ Model selected: ${model}\n\nAb apna prompt bhejo. /new se chat clear.`);
    tg('editMessageReplyMarkup', { chat_id: chat, message_id: msg, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
}

// ---------- Polling ----------
async function pollLoop() {
  let offset;
  while (true) {
    try {
      const updates = await tg('getUpdates', { timeout: 50, ...(offset !== undefined ? { offset } : {}), allowed_updates: ['message', 'callback_query'] }, 65000);
      lastPoll = Date.now();
      for (const u of updates) {
        offset = u.update_id + 1;
        (u.message ? onMessage(u.message) : u.callback_query ? onCallback(u.callback_query) : Promise.resolve())
          .catch(e => console.error('[NEBULA BOT] update failed:', e.message));
      }
    } catch (e) {
      console.warn('[NEBULA BOT] polling error:', e.message, e.code === 409 ? '(409: koi doosra instance same BOT_TOKEN use kar raha hai)' : '');
      await sleep(e.code === 409 ? 8000 : 3000);
    }
  }
}

async function start(c) {
  ctx = c;
  if (!TOKEN) return console.error('[NEBULA BOT] DISABLED: BOT_TOKEN missing in Render Environment.');
  if (!ADMINS.size) console.error('[NEBULA BOT] WARNING: ADMIN_ID missing — koi admin nahi, password nahi ban payega.');
  if (started) return; started = true;
  try {
    await tg('deleteWebhook', { drop_pending_updates: false }, 20000);
    const me = await tg('getMe', {}, 20000); botUser = me.username;
    log(`Telegram authenticated as @${me.username}; admins=${[...ADMINS].join(',') || 'NONE'}; keys=${ctx.getKeys().length}`);
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Start' }, { command: 'models', description: 'Choose model' }, { command: 'new', description: 'New chat' }, { command: 'status', description: 'Status' }, { command: 'help', description: 'Help' }] }).catch(() => {});
  } catch (e) { console.error('[NEBULA BOT] Startup failed (BOT_TOKEN galat?):', e.message); started = false; return setTimeout(() => start(c), 15000).unref(); }
  pollLoop();
}
const status = () => ({ website: 'online', botTokenConfigured: !!TOKEN, adminConfigured: ADMINS.size > 0, botUsername: botUser, lastPollSecondsAgo: lastPoll ? Math.round((Date.now() - lastPoll) / 1000) : null });

module.exports = { start, status, makeZip };
