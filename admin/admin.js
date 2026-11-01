(() => {
const W = 720, H = 1280; /* affiche verticale 9:16, en px logiques (identique à server.js) */
/* exports en format unique 9:16 : taille de page PDF (px @96dpi) et taille JPG (px) */
const PDF = [1080, 1920], JPG = [2160, 3840];
const cv = document.getElementById('cv'), ctx = cv.getContext('2d'), pane = document.getElementById('pane');
let chars = [], sel = null; // { id, name, ip, mode, created_at, parts:[{k, c, w, h, x, y, a, s}] }
const fx = n => Math.round(n * 100) / 100;

/* ---------- formes (identiques à public/app.js) ---------- */
function shape(w, h, k) {
  if (k === 'square' || k === 'circle') h = w;
  let top = -h / 2, bot = h / 2, pts = null;
  if (k === 'square' || k === 'rect') pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  else if (k === 'tri') { pts = [[0, -2 * h / 3], [w / 2, h / 3], [-w / 2, h / 3]]; top = -2 * h / 3; bot = h / 3; }
  else if (k === 'ellipse') { pts = []; const c = Math.cos(Math.PI / 12); for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; pts.push([Math.cos(a) * w / 2 / c, Math.sin(a) * h / 2 / c]); } }
  return { k, w, h, top, bot, pts };
}
const rot = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
function inside(s, x, y) {
  if (s.k === 'circle') return x * x + y * y < s.w * s.w / 4;
  if (s.k === 'ellipse') return (2 * x / s.w) ** 2 + (2 * y / s.h) ** 2 < 1;
  const p = s.pts, n = p.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % n];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
}
function shapeTag(sh, fill, attrs = '') {
  if (sh.k === 'circle') return `<circle r="${fx(sh.w / 2)}" fill="${fill}" ${attrs}/>`;
  if (sh.k === 'ellipse') return `<ellipse rx="${fx(sh.w / 2)}" ry="${fx(sh.h / 2)}" fill="${fill}" ${attrs}/>`;
  return `<polygon points="${sh.pts.map(p => fx(p[0]) + ',' + fx(p[1])).join(' ')}" fill="${fill}" ${attrs}/>`;
}

/* ---------- api : 404 = session expirée, la page redevient la connexion ---------- */
async function call(url, opt) {
  const r = await fetch(url, opt);
  if (r.status === 404 && !opt) location.reload();
  if (!r.ok) throw r.status;
  return r.json();
}
async function load() {
  const rows = await call('/api/admin/pantins');
  chars = rows.map(r => ({ ...r, parts: r.parts.map(p => ({ ...p, s: shape(p.w, p.h, p.k) })) }));
  select(sel && chars.find(c => c.id === sel.id));
}
/* une personne par IP : nom de son premier carnavalier, posés / autorisés (1 + ceux accordés ici) */
async function loadPeople() {
  const ul = document.getElementById('people');
  const rows = await call('/api/admin/personnes');
  ul.replaceChildren();
  if (!rows.length) { const li = document.createElement('li'); li.textContent = 'Aucune'; ul.append(li); }
  for (const p of rows) {
    const li = document.createElement('li'), t = document.createElement('span'), btns = document.createElement('div');
    t.textContent = (p.name || 'Sans nom') + '\n' + p.ip + ' · ' + p.posted + ' / ' + (1 + p.extra);
    /* clic sur la personne : son dernier carnavalier est sélectionné sur l'affiche */
    t.onclick = () => select(chars.find(c => c.id === p.last));
    btns.className = 'row';
    for (const [txt, d] of [['−1', -1], ['+1', 1]]) {
      const b = document.createElement('button');
      b.className = 'b t2'; b.textContent = txt; b.disabled = p.extra + d < 0;
      b.onclick = () => call('/api/admin/personnes/' + encodeURIComponent(p.ip), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra: p.extra + d }) })
        .then(loadPeople, loadPeople);
      btns.append(b);
    }
    li.append(t, btns); ul.append(li);
  }
}
async function loadBans() {
  const ul = document.getElementById('bans');
  ul.replaceChildren();
  const rows = await call('/api/admin/bans');
  if (!rows.length) { const li = document.createElement('li'); li.textContent = 'Aucune'; ul.append(li); }
  for (const { ip } of rows) {
    const li = document.createElement('li'), t = document.createElement('span'), b = document.createElement('button');
    t.textContent = ip; b.className = 'b t2'; b.textContent = 'Débannir';
    b.onclick = () => call('/api/admin/bans/' + encodeURIComponent(ip), { method: 'DELETE' }).then(loadBans, loadBans);
    li.append(t, b); ul.append(li);
  }
}

/* ---------- rendu : fond noir, le pantin choisi en avant, les autres estompés ---------- */
let K = 1, ox = 0, oy = 0;
function layout() {
  const d = window.devicePixelRatio || 1;
  cv.width = Math.round(pane.clientWidth * d); cv.height = Math.round(pane.clientHeight * d);
  K = Math.min(cv.width / W, cv.height / H); ox = (cv.width - W * K) / 2; oy = (cv.height - H * K) / 2;
  draw();
}
function path(sh) {
  ctx.beginPath();
  if (sh.k === 'circle') ctx.arc(0, 0, sh.w / 2, 0, Math.PI * 2);
  else if (sh.k === 'ellipse') ctx.ellipse(0, 0, sh.w / 2, sh.h / 2, 0, 0, Math.PI * 2);
  else { sh.pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); }
}
function draw() {
  const lw = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (const c of chars) {
    ctx.globalAlpha = sel && c !== sel ? 0.25 : 1;
    for (const p of c.parts) {
      const co = Math.cos(p.a) * K, si = Math.sin(p.a) * K;
      ctx.setTransform(co, si, -si, co, ox + p.x * K, oy + p.y * K);
      ctx.fillStyle = p.c; path(p.s); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  if (sel) { /* contour blanc par-dessus, épaisseur constante à l'écran */
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * lw / K; ctx.setLineDash([6 * lw / K, 4 * lw / K]);
    for (const p of sel.parts) {
      const co = Math.cos(p.a) * K, si = Math.sin(p.a) * K;
      ctx.setTransform(co, si, -si, co, ox + p.x * K, oy + p.y * K);
      path(p.s); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  /* bord de l'affiche, 1 px écran */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = lw; ctx.strokeStyle = '#fff';
  ctx.strokeRect(ox + lw / 2, oy + lw / 2, W * K - lw, H * K - lw);
}
new ResizeObserver(layout).observe(pane);

/* ---------- sélection ---------- */
const info = document.getElementById('info');
const MODES = { editeur: 'Créé dans l’éditeur', aleatoire: 'Créé avec « Aléatoire »' };
function select(c) {
  sel = c || null;
  info.hidden = !sel;
  if (sel) {
    document.getElementById('iname').textContent = sel.name || 'Sans nom';
    document.getElementById('iip').textContent = sel.ip === 'inconnu' ? 'IP inconnue' : 'IP ' + sel.ip;
    document.getElementById('imode').textContent = MODES[sel.mode] || 'Mode inconnu';
    document.getElementById('idate').textContent = new Date(sel.created_at).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
    document.getElementById('ban').disabled = sel.ip === 'inconnu';
  }
  draw();
}
cv.addEventListener('click', e => {
  const d = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) * d - ox) / K, y = ((e.clientY - r.top) * d - oy) / K;
  let hit = null;
  for (let j = chars.length - 1; j >= 0 && !hit; j--)
    for (const p of chars[j].parts) {
      const q = rot({ x: x - p.x, y: y - p.y }, -p.a);
      if (inside(p.s, q.x, q.y)) { hit = chars[j]; break; }
    }
  select(hit);
});

/* ---------- confirmation ---------- */
const pop = document.getElementById('pop');
let onYes = null;
function ask(msg, yes, fn) {
  document.getElementById('msg').textContent = msg;
  document.getElementById('yes').textContent = yes;
  onYes = fn; pop.hidden = false;
}
const label = c => c.name ? '« ' + c.name + ' »' : 'ce carnavalier';
document.getElementById('del').onclick = () => { const c = sel; ask('Supprimer ' + label(c) + ' ?', 'Supprimer',
  () => call('/api/admin/pantins/' + c.id, { method: 'DELETE' }).finally(() => { load(); loadPeople(); })); };
document.getElementById('ban').onclick = () => { const c = sel; ask('Supprimer ' + label(c) + ' et bannir l’IP ' + c.ip + ' ? Elle ne pourra plus poser de carnavalier.', 'Bannir',
  () => call('/api/admin/pantins/' + c.id + '/ban', { method: 'POST' }).finally(() => { load(); loadPeople(); loadBans(); })); };
document.getElementById('yes').onclick = () => { pop.hidden = true; onYes().catch(() => {}); };
document.getElementById('no').onclick = () => { pop.hidden = true; };
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!pop.hidden) pop.hidden = true;
  else select(null);
});

/* ---------- export (même fonctionnement que la v1 du générateur, l'affiche telle que publiée) ---------- */
function buildSVG() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>`;
  /* un groupe <g> par pantin : dans Affinity, chaque pantin arrive déjà groupé (torse + tête + membres) */
  chars.forEach((c, i) => {
    s += `<g id="pantin-${String(i + 1).padStart(2, '0')}">`;
    for (const p of c.parts) s += shapeTag(p.s, p.c, `transform="translate(${fx(p.x)} ${fx(p.y)}) rotate(${fx(p.a * 180 / Math.PI)})"`);
    s += '</g>';
  });
  return s + '</svg>';
}
function fname(ext) {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `affiche-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.${ext}`;
}
function save(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const exportSVG = () => save(new Blob([buildSVG()], { type: 'image/svg+xml' }), fname('svg'));
function exportJPG() {
  const svg = buildSVG(), [pw, ph] = JPG, img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = pw; c.height = ph;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(b => save(b, fname('jpg')), 'image/jpeg', 0.95);
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
async function exportPDF() {
  const [w, h] = PDF, holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;';
  holder.innerHTML = buildSVG(); document.body.appendChild(holder);
  try {
    const pdf = new window.jspdf.jsPDF({ orientation: w >= h ? 'l' : 'p', unit: 'px', format: [w, h], hotfixes: ['px_scaling'] });
    const fn = (window.svg2pdf && window.svg2pdf.svg2pdf) || window.svg2pdf;
    await fn(holder.firstElementChild, pdf, { x: 0, y: 0, width: w, height: h });
    pdf.save(fname('pdf'));
  } finally { holder.remove(); }
}
document.getElementById('svg').onclick = exportSVG;
document.getElementById('jpg').onclick = exportJPG;
document.getElementById('pdf').onclick = exportPDF;

/* ---------- init : les nouveaux carnavaliers arrivent tout seuls ---------- */
load().catch(() => {}); loadPeople().catch(() => {}); loadBans().catch(() => {});
setInterval(() => { if (pop.hidden) { load().catch(() => {}); loadPeople().catch(() => {}); } }, 15000);
})();
