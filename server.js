/* Serveur de l'affiche : fichiers statiques de public/ + API des pantins sauvegardés (SQLite local ou Turso)
   + panel admin caché (admin/). Aucune dépendance : node:http, node:sqlite et fetch (Node 22.13+). */
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public'), ADM = path.join(ROOT, 'admin');
const PORT = +process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
/* nombre de proxys de confiance devant le serveur : 0 = X-Forwarded-For ignoré (falsifiable) */
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY, 10) || 0);

/* ---------- panel admin : chemin et mot de passe uniquement par variables d'environnement ---------- */
const ADMIN_PATH = process.env.ADMIN_PATH || '', ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN = /^\/[\w-]+$/.test(ADMIN_PATH) && !/^\/api(?:$|[\W_])/i.test(ADMIN_PATH) && ADMIN_PASSWORD !== '';
if ((ADMIN_PATH || ADMIN_PASSWORD) && !ADMIN) console.warn('Panel admin désactivé : ADMIN_PATH (ex. /mon-chemin-secret) et ADMIN_PASSWORD sont requis.');

/* ---------- base ---------- */
/* en ligne : base Turso (SQLite hébergé), interrogée par son API HTTP, sans dépendance.
   Sinon : fichier SQLite local dans DATA_DIR, le disque Railway s'il y en a un, ou data/.
   Les deux exposent la même interface asynchrone : stmt(sql).all / get / run avec des paramètres ? */
const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (TURSO_URL && !/^(https:\/\/[\w.-]+|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(TURSO_URL)) /* http : seulement `turso dev` en local */ throw new Error('TURSO_DATABASE_URL invalide');
let stmt;
if (TURSO_URL) {
  const arg = v => typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : v == null ? { type: 'null' } : { type: 'text', value: String(v) };
  const val = v => v.type === 'integer' ? Number(v.value) : v.type === 'null' ? null : v.value;
  stmt = sql => {
    const exec = async args => {
      const r = await fetch(TURSO_URL + '/v2/pipeline', {
        method: 'POST', headers: { Authorization: 'Bearer ' + TURSO_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(arg) } }, { type: 'close' }] })
      });
      if (!r.ok) throw new Error('Turso : HTTP ' + r.status);
      const out = (await r.json()).results[0];
      if (out.type !== 'ok') throw new Error('Turso : ' + (out.error && out.error.message));
      const { cols, rows, affected_row_count, last_insert_rowid } = out.response.result;
      return { rows: rows.map(row => Object.fromEntries(row.map((v, i) => [cols[i].name, val(v)]))), changes: affected_row_count, lastInsertRowid: last_insert_rowid };
    };
    return { all: async (...a) => (await exec(a)).rows, get: async (...a) => (await exec(a)).rows[0], run: (...a) => exec(a) };
  };
} else {
  const DATA = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
  fs.mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(path.join(DATA, 'pantins.db'));
  stmt = sql => {
    const s = db.prepare(sql);
    return { all: async (...a) => s.all(...a), get: async (...a) => s.get(...a), run: async (...a) => s.run(...a) };
  };
}
await stmt(`CREATE TABLE IF NOT EXISTS pantins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parts TEXT NOT NULL,
  created_at TEXT NOT NULL
)`).run();
/* migration : ip et mode ajoutés sans toucher aux pantins existants, qui restent « inconnu » */
const cols = (await stmt('PRAGMA table_info(pantins)').all()).map(c => c.name);
if (!cols.includes('ip')) await stmt("ALTER TABLE pantins ADD COLUMN ip TEXT NOT NULL DEFAULT 'inconnu'").run();
if (!cols.includes('mode')) await stmt("ALTER TABLE pantins ADD COLUMN mode TEXT NOT NULL DEFAULT 'inconnu'").run();
await stmt('CREATE TABLE IF NOT EXISTS bans (ip TEXT PRIMARY KEY, created_at TEXT NOT NULL)').run();
/* un carnavalier par IP ; n = carnavaliers en plus accordés depuis le panel */
await stmt('CREATE TABLE IF NOT EXISTS extras (ip TEXT PRIMARY KEY, n INTEGER NOT NULL)').run();
/* requêtes préparées uniquement : les valeurs ne sont jamais concaténées dans le SQL */
const qAll = stmt('SELECT id, name, parts FROM pantins WHERE id > ? ORDER BY id'); /* public : jamais l'ip */
const qAdd = stmt('INSERT INTO pantins (name, parts, created_at, ip, mode) VALUES (?, ?, ?, ?, ?)');
const qAdmAll = stmt('SELECT id, name, parts, created_at, ip, mode FROM pantins ORDER BY id');
const qIp = stmt('SELECT ip FROM pantins WHERE id = ?');
const qDel = stmt('DELETE FROM pantins WHERE id = ?');
const qBanned = stmt('SELECT 1 AS x FROM bans WHERE ip = ?');
const qBan = stmt('INSERT OR IGNORE INTO bans (ip, created_at) VALUES (?, ?)');
const qBans = stmt('SELECT ip, created_at FROM bans ORDER BY created_at DESC');
const qUnban = stmt('DELETE FROM bans WHERE ip = ?');
const qPosted = stmt('SELECT COUNT(*) AS n FROM pantins WHERE ip = ?');
const qExtra = stmt('SELECT n FROM extras WHERE ip = ?');
const qExtras = stmt('SELECT ip, n FROM extras');
const qSetExtra = stmt('INSERT INTO extras (ip, n) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET n = excluded.n');
const qDelExtra = stmt('DELETE FROM extras WHERE ip = ?');

/* ---------- validation (mêmes règles que le client, qui n'est jamais cru sur parole) ---------- */
const W = 720, H = 1280; /* taille logique de l'affiche, identique à public/app.js et admin/admin.js */
const KINDS = ['square', 'rect', 'tri', 'circle', 'ellipse'];
/* les seules couleurs acceptées ; même liste dans public/app.js */
const PALETTE = ['#04e762', '#f5b700', '#dc0073', '#008bf8', '#89fc00'];
const MODES = ['aleatoire', 'editeur'];
const NAME_RE = /^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u; /* lettres, chiffres, espaces et tirets simples */
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').trim();
  if (s === '') return '';
  if (s.length > 40 || !NAME_RE.test(s)) return null;
  if (s.split(/[ -]/).some(w => w.length > 25)) return null;
  return s;
}
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function cleanParts(v) {
  if (!Array.isArray(v) || v.length !== 6) return null;
  const out = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') return null;
    if (!KINDS.includes(p.k) || typeof p.c !== 'string' || !PALETTE.includes(p.c.toLowerCase())) return null;
    if (!num(p.w, 2, 200) || !num(p.h, 2, 200) || !num(p.x, -300, W + 300) || !num(p.y, -3000, H + 100) || !num(p.a, -1e4, 1e4)) return null;
    /* on ne garde que les champs connus, arrondis : rien d'autre n'est stocké */
    const r = n => Math.round(n * 100) / 100;
    out.push({ k: p.k, c: p.c.toLowerCase(), w: r(p.w), h: r(p.h), x: r(p.x), y: r(p.y), a: Math.round(p.a * 1e4) / 1e4 });
  }
  return out;
}
/* adresse du visiteur : la connexion elle-même, ou X-Forwarded-For seulement si TRUST_PROXY le permet.
   Chaque proxy ajoute l'adresse qu'il voit à la fin : on prend celle ajoutée par le plus lointain des proxys de confiance */
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length >= TRUST_PROXY) ip = xff[xff.length - TRUST_PROXY];
  }
  ip = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return net.isIP(ip) ? ip : 'inconnu';
}

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
/* réponse identique à un fichier absent : une route admin sans session n'existe pas */
const notFound = res => send(res, 404, 'introuvable', 'text/plain');
/* corps de la requête, ou null s'il dépasse max octets (la connexion est alors coupée) */
const readBody = (req, max) => new Promise(ok => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', d => { raw += d; if (raw.length > max) { req.destroy(); ok(null); } });
  req.on('end', () => ok(raw));
});
const last = new Map(); /* ip -> date du dernier ajout : un pantin toutes les 5 s par adresse */
const pending = new Set(); /* ip dont un ajout est en cours : deux envois simultanés ne dépassent pas la limite */
/* carnavaliers que cette IP peut encore poser : 1 + ceux accordés dans le panel, moins ceux déjà posés.
   IP bannie ou inconnue : 0 */
async function left(ip) {
  if (ip === 'inconnu' || await qBanned.get(ip)) return 0;
  const extra = await qExtra.get(ip), posted = await qPosted.get(ip);
  return Math.max(0, 1 + (extra ? extra.n : 0) - posted.n);
}

async function api(req, res, url) {
  if (req.method === 'GET') {
    const after = Math.max(0, parseInt(url.searchParams.get('after'), 10) || 0);
    return send(res, 200, (await qAll.all(after)).map(r => ({ id: r.id, name: r.name, parts: JSON.parse(r.parts) })));
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'méthode' });
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'format' });
  const ip = clientIp(req), now = Date.now();
  /* IP bannie : un refus comme un autre, sans dire pourquoi */
  if (await qBanned.get(ip)) return send(res, 403, { error: 'refusé' });
  if (now - (last.get(ip) || 0) < 5000) return send(res, 429, { error: 'trop vite' });
  const raw = await readBody(req, 8192);
  if (raw === null) return;
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'json' }); }
  const name = cleanName(body && body.name), parts = cleanParts(body && body.parts);
  const mode = body && MODES.includes(body.mode) ? body.mode : null;
  if (name === null || !parts || !mode) return send(res, 400, { error: 'invalide' });
  if (pending.has(ip)) return send(res, 429, { error: 'trop vite' });
  pending.add(ip);
  try {
    if (!await left(ip)) return send(res, 403, { error: 'refusé' });
    last.set(ip, now);
    const { lastInsertRowid } = await qAdd.run(name, JSON.stringify(parts), new Date().toISOString(), ip, mode);
    send(res, 201, { id: Number(lastInsertRowid) });
  } finally { pending.delete(ip); }
}

function serveFile(req, res, dir, rel, extra = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'méthode', 'text/plain');
  let p;
  try { p = decodeURIComponent(rel); } catch { return send(res, 400, 'url', 'text/plain'); }
  const file = path.join(dir, path.normalize(p === '/' ? '/index.html' : p));
  if (!file.startsWith(dir + path.sep)) return send(res, 403, 'interdit', 'text/plain'); /* pas de ../ */
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...extra });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ---------- admin : session et connexion ---------- */
const SESSION_MS = 4 * 3600e3, MAX_TRIES = 5, LOCK_MS = 15 * 60e3;
const sessions = new Map(); /* jeton -> expiration */
const tries = new Map();    /* ip -> { n: essais ratés, until: fin du blocage } */
function hasSession(req) {
  const m = /(?:^|;\s*)adm=([\w-]{43})(?:;|$)/.exec(req.headers.cookie || '');
  const exp = m && sessions.get(m[1]);
  if (!exp) return false;
  if (exp > Date.now()) return true;
  sessions.delete(m[1]);
  return false;
}
/* empreintes de même longueur : la comparaison prend le même temps quel que soit le mot de passe essayé */
const sha = s => crypto.createHash('sha256').update(s).digest();
const PW = sha(ADMIN_PASSWORD);
const goodPassword = p => crypto.timingSafeEqual(sha(p), PW);
const ADMIN_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };
/* page de connexion : aucun contenu venant de la requête n'y est inséré */
const loginPage = msg => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Admin</title>
<style>
.t2{font:700 16px/1 Helvetica,"Helvetica Neue",Arial,sans-serif;text-transform:uppercase}
.t3{font:400 16px/1.3 Helvetica,"Helvetica Neue",Arial,sans-serif}
html,body{margin:0;height:100%;background:#000;color:#fff}
form{height:100%;display:flex;flex-direction:column;gap:16px;align-items:stretch;justify-content:center;width:320px;margin:0 auto;padding:16px;box-sizing:border-box}
input,button{border:1px solid #fff;border-radius:0;margin:0;padding:20px;background:#000;color:#fff;outline:none}
button{cursor:pointer}
button:hover{background:#fff;color:#000}
p{margin:0}
</style></head><body>
<form method="post" autocomplete="off">
<input class="t3" type="password" name="password" required autofocus aria-label="Mot de passe" placeholder="Mot de passe">
<button class="t2">Entrer</button>
${msg ? `<p class="t3">${msg}</p>` : ''}
</form></body></html>`;

async function login(req, res) {
  const ip = clientIp(req), now = Date.now(), t = tries.get(ip) || { n: 0, until: 0 };
  const page = (code, msg) => send(res, code, loginPage(msg), MIME['.html'], ADMIN_HEADERS);
  if (t.until > now) return page(429, 'Trop d’essais. Réessaie dans ' + Math.ceil((t.until - now) / 60e3) + ' min.');
  const raw = await readBody(req, 1024);
  if (raw === null) return;
  const pw = new URLSearchParams(raw).get('password') || '';
  if (!goodPassword(pw)) {
    t.n++;
    if (t.n >= MAX_TRIES) { t.n = 0; t.until = now + LOCK_MS; }
    tries.set(ip, t);
    return t.until > now ? page(429, 'Trop d’essais. Réessaie dans ' + LOCK_MS / 60e3 + ' min.') : page(401, 'Mot de passe incorrect.');
  }
  tries.delete(ip);
  for (const [k, exp] of sessions) if (exp <= now) sessions.delete(k);
  const tok = crypto.randomBytes(32).toString('base64url');
  sessions.set(tok, now + SESSION_MS);
  res.writeHead(303, { ...HEADERS, ...ADMIN_HEADERS, Location: ADMIN_PATH + '/',
    'Set-Cookie': `adm=${tok}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict${PROD ? '; Secure' : ''}` });
  res.end();
}

/* ADMIN_PATH/ : connexion sans session, panel avec. Les fichiers du panel n'existent que pour une session */
function adminPage(req, res, url) {
  if (url.pathname === ADMIN_PATH) return send(res, 301, '', 'text/plain', { Location: ADMIN_PATH + '/' });
  const rel = url.pathname.slice(ADMIN_PATH.length), ok = hasSession(req);
  if (rel === '/') {
    if (req.method === 'POST') return login(req, res).catch(fail(res));
    if (!ok) return send(res, 200, loginPage(''), MIME['.html'], ADMIN_HEADERS);
  }
  if (!ok) return notFound(res);
  serveFile(req, res, ADM, rel, ADMIN_HEADERS);
}

async function adminApi(req, res, url) {
  if (!ADMIN || !hasSession(req)) return notFound(res);
  /* en plus de SameSite=Strict : une action venue d'un autre site est refusée */
  const o = req.headers.origin;
  if (req.method !== 'GET' && o) { let h; try { h = new URL(o).host; } catch {} if (h !== req.headers.host) return send(res, 403, { error: 'origine' }); }
  const p = url.pathname.slice('/api/admin'.length), m = req.method;
  let r;
  if (m === 'GET' && p === '/pantins')
    return send(res, 200, (await qAdmAll.all()).map(r => ({ id: r.id, name: r.name, parts: JSON.parse(r.parts), created_at: r.created_at, ip: r.ip, mode: r.mode })), undefined, ADMIN_HEADERS);
  if (m === 'DELETE' && (r = /^\/pantins\/(\d{1,15})$/.exec(p))) {
    const { changes } = await qDel.run(+r[1]);
    return send(res, changes ? 200 : 404, { ok: !!changes });
  }
  /* l'IP à bannir est lue en base, jamais fournie par le client */
  if (m === 'POST' && (r = /^\/pantins\/(\d{1,15})\/ban$/.exec(p))) {
    const row = await qIp.get(+r[1]);
    if (!row) return send(res, 404, { ok: false });
    if (row.ip === 'inconnu') return send(res, 400, { error: 'ip inconnue' });
    await qBan.run(row.ip, new Date().toISOString());
    await qDel.run(+r[1]);
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/bans') return send(res, 200, (await qBans.all()).map(r => ({ ip: r.ip, created_at: r.created_at })), undefined, ADMIN_HEADERS);
  /* une personne = une IP ; son nom est celui de son premier carnavalier */
  if (m === 'GET' && p === '/personnes') {
    const people = new Map(), get = ip => people.get(ip) || people.set(ip, { ip, name: '', posted: 0, extra: 0, last: 0 }).get(ip);
    for (const r of await qAdmAll.all()) {
      if (r.ip === 'inconnu') continue;
      const o = get(r.ip);
      if (!o.posted) o.name = r.name;
      o.posted++; o.last = r.id;
    }
    for (const r of await qExtras.all()) get(r.ip).extra = r.n;
    return send(res, 200, [...people.values()].sort((a, b) => b.last - a.last), undefined, ADMIN_HEADERS);
  }
  /* carnavaliers en plus pour une IP : { extra: n } */
  if (m === 'PUT' && (r = /^\/personnes\/([^/]{1,64})$/.exec(p))) {
    let ip;
    try { ip = decodeURIComponent(r[1]); } catch { return send(res, 400, { error: 'ip' }); }
    if (!net.isIP(ip)) return send(res, 400, { error: 'ip' });
    const raw = await readBody(req, 256);
    if (raw === null) return;
    let n;
    try { n = JSON.parse(raw).extra; } catch { return send(res, 400, { error: 'json' }); }
    if (!Number.isInteger(n) || n < 0 || n > 999) return send(res, 400, { error: 'invalide' });
    await (n ? qSetExtra.run(ip, n) : qDelExtra.run(ip));
    return send(res, 200, { ok: true });
  }
  if (m === 'DELETE' && (r = /^\/bans\/([^/]{1,64})$/.exec(p))) {
    let ip;
    try { ip = decodeURIComponent(r[1]); } catch { return send(res, 400, { error: 'ip' }); }
    if (!net.isIP(ip)) return send(res, 400, { error: 'ip' });
    await qUnban.run(ip);
    return send(res, 200, { ok: true });
  }
  notFound(res);
}

/* une erreur (base injoignable…) donne un 500 sans détail ; le détail reste dans les journaux du serveur */
const fail = res => e => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'serveur' }); else res.destroy(); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/pantins') return api(req, res, url).catch(fail(res));
  /* combien de carnavaliers ce visiteur peut encore poser (rien d'autre n'est renvoyé) */
  if (url.pathname === '/api/reste') return left(clientIp(req)).then(n => send(res, 200, { reste: n })).catch(fail(res));
  if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) return adminApi(req, res, url).catch(fail(res));
  if (ADMIN && (url.pathname === ADMIN_PATH || url.pathname.startsWith(ADMIN_PATH + '/'))) return adminPage(req, res, url);
  serveFile(req, res, PUB, url.pathname);
}).listen(PORT, () => console.log(`Affiche : http://localhost:${PORT}` + (ADMIN ? ` (panel admin actif)` : '')));
