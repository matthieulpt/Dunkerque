(() => {
const pl = planck;
const S = 30; /* px par mètre : un pantin mesure 1 à 4 m, la plage où Box2D est le plus fiable */
const STEP = 1 / 120; /* 2 pas par frame */
const W = 720, H = 1280; /* affiche verticale 9:16, en px logiques (identique à server.js) */
const U = W / 32; /* unité de taille des pantins : plus petits que dans le générateur d'origine */
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const pane = document.getElementById('pane'), home = document.getElementById('home');

/* y vers le bas comme l'écran : la gravité est positive, les angles tournent dans le sens du canvas */
const world = new pl.World({ gravity: pl.Vec2(0, 40) });
const chars = []; // { name, mode, mine, colors, parts:[{s, body, color}], joints, ign, landed, frozen }
const V = (x, y) => pl.Vec2(x / S, y / S);

/* ---------- utilitaires ---------- */
const rng = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = (r, a, b) => a + (b - a) * r();
/* les seules couleurs des carnavaliers (éditeur et aléatoire) ; même liste dans server.js */
const PALETTE = ['#04e762', '#f5b700', '#dc0073', '#008bf8', '#89fc00'];
const fx = n => Math.round(n * 100) / 100;

/* ---------- monde ---------- */
let floor;
{
  const t = 1000 / S, w = W / S, h = H / S, o = { friction: 0.9, restitution: 0 };
  const walls = world.createBody();
  floor = walls.createFixture(pl.Box(w / 2 + t, t / 2, pl.Vec2(w / 2, h + t / 2)), o);
  walls.createFixture(pl.Box(t / 2, 5000 / S, pl.Vec2(-t / 2, h / 2)), o);
  walls.createFixture(pl.Box(t / 2, 5000 / S, pl.Vec2(w + t / 2, h / 2)), o);
}

/* ---------- formes ---------- */
const KINDS = ['square', 'rect', 'tri', 'circle', 'ellipse'];
function shape(r, w, h, k) { /* k imposé par l'éditeur, sinon tiré au hasard */
  k = k || KINDS[Math.floor(r() * 5)];
  if (k === 'square' || k === 'circle') h = w;
  let top = -h / 2, bot = h / 2, pts = null;
  if (k === 'square' || k === 'rect') pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  else if (k === 'tri') { pts = [[0, -2 * h / 3], [w / 2, h / 3], [-w / 2, h / 3]]; top = -2 * h / 3; bot = h / 3; }
  /* ellipse : polygone de 12 côtés (max Box2D) circonscrit, le dessin ne déborde jamais du bloc physique */
  else if (k === 'ellipse') { pts = []; const c = Math.cos(Math.PI / 12); for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; pts.push([Math.cos(a) * w / 2 / c, Math.sin(a) * h / 2 / c]); } }
  return { k, w, h, top, bot, pts };
}
const geom = s => s.k === 'circle' ? pl.Circle(s.w / 2 / S) : pl.Polygon(s.pts.map(p => pl.Vec2(p[0] / S, p[1] / S)));
const rot = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
/* point (repère de la forme) dans la forme dessinée ? */
function inside(s, x, y) {
  if (s.k === 'circle') return x * x + y * y < s.w * s.w / 4;
  if (s.k === 'ellipse') return (2 * x / s.w) ** 2 + (2 * y / s.h) ** 2 < 1;
  const p = s.pts, n = p.length;
  for (let i = 0; i < n; i++) { /* convexe : du même côté de chaque arête */
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % n];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
}
/* nuage de points couvrant la forme, pour mesurer quelle part d'un membre est cachée dans le torse */
function samples(s) {
  const out = [];
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
    const x = -s.w / 2 + s.w * (i + 0.5) / 9, y = s.top + (s.bot - s.top) * (j + 0.5) / 9;
    if (inside(s, x, y)) out.push({ x, y });
  }
  return out;
}
/* bord du torse : on part d'un point intérieur et on avance dans la direction d jusqu'à sortir */
function edge(s, o, d) {
  let a = 0, b = Math.max(s.w, s.h);
  for (let i = 0; i < 30; i++) { const m = (a + b) / 2; inside(s, o.x + d.x * m, o.y + d.y * m) ? a = m : b = m; }
  return { x: o.x + d.x * a, y: o.y + d.y * a };
}

/* ---------- personnage ---------- */
/* torse + tête + 2 bras + 2 jambes reliés par des pivots à butées (articulations Box2D).
   morceaux dans l'ordre de création : torse, tête, bras G, jambe G, bras D, jambe D.
   plages de taille [largeur min, max, hauteur min, max] en unités U */
const SIZES = { T: [1.3, 2.4, 1.8, 3.2], H: [1.1, 2.1, 1.1, 2.1], A: [0.5, 1.1, 1.8, 3.4], L: [0.6, 1.2, 2, 3.6] };
const PARTS = ['T', 'H', 'A', 'L', 'A', 'L'];
/* taille fixe d'un morceau dessiné dans l'éditeur : milieu des plages ; cercle et carré prennent la moyenne */
function nominal(i, k) {
  const [w0, w1, h0, h1] = SIZES[PARTS[i]];
  let w = (w0 + w1) / 2, h = (h0 + h1) / 2;
  if (k === 'square' || k === 'circle') w = h = (w + h) / 2;
  /* rectangle et ovale toujours nettement allongés (la tête a des plages carrées : sinon carré et rond) */
  else if ((k === 'rect' || k === 'ellipse') && h < w * 1.35) { const m = (w + h) / 2; w = m / 1.2; h = m * 1.2; }
  return { w, h };
}
/* spec : [{k, c}] par morceau (personnage de l'éditeur), ou null pour un pantin aléatoire */
function spawn(spec) {
  /* on retire un pantin entier (formes, tailles, pose) tant que deux de ses membres ne trouvent pas
     de place sans se recouvrir ; en dernier recours ces paires s'ignorent */
  let d;
  for (let k = 0; k < 20; k++) { d = design((Math.random() * 4294967296) >>> 0, spec); if (!d.c.ign.size) break; }
  return build(d);
}
function design(seed, spec) {
  const r = rng(seed);
  /* une couleur de la palette par morceau */
  const colors = spec ? spec.map(p => p.c) : PARTS.map(() => PALETTE[Math.floor(r() * PALETTE.length)]);
  const mk = i => {
    if (spec) { const n = nominal(i, spec[i].k); return shape(r, n.w * U, n.h * U, spec[i].k); }
    const [w0, w1, h0, h1] = SIZES[PARTS[i]];
    return shape(r, R(r, w0, w1) * U, R(r, h0, h1) * U);
  };
  const T = mk(0), Hd = mk(1);
  /* apparaît au-dessus de tout ce qui est déjà là : jamais de recouvrement au spawn */
  let top = 0;
  for (const c of chars) for (const { body } of c.parts) top = Math.min(top, body.getFixtureList().getAABB(0).lowerBound.y * S);
  const m = 5 * U, cx = R(r, m, Math.max(m + 1, W - m)), cy = Math.min(-7 * U, top - 7 * U), a0 = R(r, -0.6, 0.6);
  const c = { name: '', mode: '', mine: false, colors, parts: [], joints: [], ign: new Set(), landed: 0, frozen: false };

  /* membres : accrochés au BORD du torse (pas à l'intérieur), pivot juste à l'entrée du membre.
     La plage d'angle de chaque articulation est calculée pour la forme réelle du torse et du membre :
     au-delà, plus d'un quart du membre serait caché dans le torse (qui l'ignore en collision) */
  const pose = [{ s: T, x: cx, y: cy, a: a0 }], links = [], MAXF = 0.25;
  const limb = (s, o, d, dir, spread) => {
    const n = Math.hypot(d.x, d.y); d = { x: d.x / n, y: d.y / n };
    const anchor = edge(T, o, d), inset = 0.18 * Math.min(s.w, s.bot - s.top);
    const piv = { x: 0, y: dir > 0 ? s.top + inset : s.bot - inset }, pts = samples(s);
    const frac = th => pts.filter(p => { const q = rot({ x: p.x - piv.x, y: p.y - piv.y }, th); return inside(T, anchor.x + q.x, anchor.y + q.y); }).length / pts.length;
    const th0 = Math.atan2(d.y, d.x) - Math.atan2(dir, 0);
    let lo = th0, hi = th0;
    while (lo > th0 - spread && frac(lo - 0.05) <= MAXF) lo -= 0.05;
    while (hi < th0 + spread && frac(hi + 0.05) <= MAXF) hi += 0.05;
    /* pose : on tire un angle dans [lo, hi] où le membre ne recouvre aucun autre membre */
    const aw = rot(anchor, a0), g = geom(s);
    let x, y, a, hits;
    for (let t = 0; t < 48; t++) {
      const th = R(r, lo, hi), q = rot(piv, a0 + th);
      x = cx + aw.x - q.x; y = cy + aw.y - q.y; a = a0 + th;
      const xf = pl.Transform(V(x, y), a);
      hits = [];
      for (let i = 1; i < pose.length; i++)
        if (pl.testOverlap(g, 0, geom(pose[i].s), 0, xf, pl.Transform(V(pose[i].x, pose[i].y), pose[i].a))) hits.push(i);
      if (!hits.length) break;
    }
    /* aucune pose libre trouvée : ces paires-là ne se collisionnent pas (sinon elles s'éjectent) */
    for (const i of hits) c.ign.add(i + '-' + pose.length);
    links.push({ i: pose.length, px: cx + aw.x, py: cy + aw.y, lo: lo - (a - a0), hi: hi - (a - a0) });
    pose.push({ s, x, y, a });
  };
  limb(Hd, { x: 0, y: 0 }, { x: 0, y: -1 }, -1, 0.6);
  for (const sg of [-1, 1]) {
    const o = sg < 0 ? 2 : 4;
    const A = mk(o);     limb(A, { x: 0, y: T.top + (T.bot - T.top) * 0.3 }, { x: sg, y: 0 }, 1, 1.6);
    const L = mk(o + 1); limb(L, { x: sg * T.w * 0.22, y: 0 }, { x: sg * 0.25, y: 1 }, 1, 0.9);
  }
  return { c, pose, links };
}
function build({ c, pose, links }) {
  pose.forEach((p, i) => {
    const body = world.createBody({ type: 'dynamic', position: V(p.x, p.y), angle: p.a, linearDamping: 0.2, angularDamping: 0.6 });
    body.createFixture(geom(p.s), { density: i ? 3 : 4, friction: 0.8, restitution: 0 });
    body.setUserData({ c, i });
    c.parts.push({ s: p.s, body, color: c.colors[i] });
  });
  /* pivots à butées ; le moteur à vitesse nulle sert de frottement d'articulation : membres lourds, pas mous */
  const torso = c.parts[0].body;
  for (const l of links) {
    const b = c.parts[l.i].body;
    c.joints.push(world.createJoint(pl.RevoluteJoint({
      enableLimit: true, lowerAngle: l.lo, upperAngle: l.hi,
      enableMotor: true, motorSpeed: 0, maxMotorTorque: b.getMass() * 6
    }, torso, b, V(l.px, l.py))));
  }
  chars.push(c);
  return c;
}
/* pantin sauvegardé : posé figé, exactement là où il s'était arrêté */
function restore({ name, parts }) {
  const c = { name, mine: false, colors: parts.map(p => p.c), parts: [], joints: [], ign: new Set(), landed: 1, frozen: true };
  parts.forEach((p, i) => {
    const s = shape(null, p.w, p.h, p.k);
    const body = world.createBody({ type: 'static', position: V(p.x, p.y), angle: p.a });
    body.createFixture(geom(s), { friction: 0.8, restitution: 0 });
    body.setUserData({ c, i });
    c.parts.push({ s, body, color: p.c });
  });
  chars.push(c);
}

/* paires d'un même pantin qui se recouvraient à la création : contact désactivé */
world.on('pre-solve', contact => {
  const a = contact.getFixtureA().getBody().getUserData(), b = contact.getFixtureB().getBody().getUserData();
  if (a && b && a.c === b.c && (a.c.ign.has(a.i + '-' + b.i) || a.c.ign.has(b.i + '-' + a.i))) contact.setEnabled(false);
});
/* un pantin a « atterri » quand il touche le sol ou un pantin déjà figé */
world.on('begin-contact', contact => {
  const fa = contact.getFixtureA(), fb = contact.getFixtureB();
  const ua = fa.getBody().getUserData(), ub = fb.getBody().getUserData();
  const solid = (f, u) => f === floor || (u && u.c.frozen);
  if (ua && !ua.c.landed && solid(fb, ub)) ua.c.landed = 1;
  if (ub && !ub.c.landed && solid(fa, ua)) ub.c.landed = 1;
});

/* un pas de simulation, puis : un pantin dont tous les morceaux dorment (Box2D les endort après ~0,5 s
   d'immobilité) est figé définitivement et sauvegardé ; les suivants s'empilent dessus comme
   sur du solide. Filet : 4 s après avoir atterri, il est figé quoi qu'il arrive */
function step() {
  for (const c of chars) {
    if (c.frozen) continue;
    for (const { body } of c.parts) { /* vitesse plafonnée : pas de traversée de membres fins */
      const v = body.getLinearVelocity(), n = v.length();
      if (n > 25) body.setLinearVelocity(pl.Vec2(v.x * 25 / n, v.y * 25 / n));
    }
  }
  world.step(STEP, 10, 8);
  for (const c of chars) {
    if (c.frozen) continue;
    if (c.landed) c.landed++;
    if (c.parts.every(p => !p.body.isAwake()) || c.landed > 4 / STEP) {
      c.frozen = true;
      for (const j of c.joints) world.destroyJoint(j);
      for (const { body } of c.parts) body.setStatic();
      if (c.mine) persist(c);
    }
  }
}

/* ---------- sauvegarde ---------- */
const known = new Set(); /* ids déjà sur l'affiche, y compris les nôtres */
let lastId = 0;
function persist(c, tries = 3) {
  const parts = c.parts.map(({ s, body, color }) => {
    const p = body.getPosition();
    return { k: s.k, c: color, w: s.w, h: s.h, x: p.x * S, y: p.y * S, a: body.getAngle() };
  });
  fetch('api/pantins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: c.name, mode: c.mode, parts }) })
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(d => known.add(d.id))
    .catch(st => { if (st !== 403 && tries > 1) setTimeout(() => persist(c, tries - 1), 6000); }); /* 403 : refusé pour de bon */
}
/* les pantins créés ailleurs entre-temps arrivent tous seuls, quand rien ne tombe */
function pull() {
  if (chars.some(c => !c.frozen)) return;
  fetch('api/pantins?after=' + lastId).then(r => r.json()).then(rows => {
    if (chars.some(c => !c.frozen)) return;
    for (const row of rows) {
      lastId = Math.max(lastId, row.id);
      if (!known.has(row.id)) { known.add(row.id); restore(row); }
    }
  }).catch(() => {});
}
pull();
setInterval(pull, 15000);

/* ---------- caméra ---------- */
/* plein cadre : l'affiche entière. Suivi : cadré serré sur le torse du pantin qui tombe ;
   dès qu'il touche les autres, la caméra recule doucement jusqu'au plein cadre */
const FOLLOW_H = 520, BACK_DELAY = 400, BACK_TIME = 2600;
const cam = { mode: 'full', c: null, x: W / 2, y: H / 2, t0: 0 };
let K = 1; /* px écran (device) par px logique en plein cadre */
function layout() {
  const d = window.devicePixelRatio || 1;
  cv.width = Math.round(pane.clientWidth * d); cv.height = Math.round(pane.clientHeight * d);
  K = Math.min(cv.width / W, cv.height / H);
}
new ResizeObserver(layout).observe(pane);
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
function view(now) {
  const full = { x: W / 2, y: H / 2, s: K };
  if (cam.mode === 'full') return full;
  const p = cam.c.parts[0].body.getPosition();
  cam.x += (p.x * S - cam.x) * 0.2; cam.y += (p.y * S - cam.y) * 0.2;
  const s = cv.height / FOLLOW_H, half = cv.width / s / 2;
  const f = { x: half * 2 >= W ? W / 2 : Math.max(half, Math.min(W - half, cam.x)), y: cam.y, s };
  if (cam.mode === 'follow') {
    if (cam.c.landed) { cam.mode = 'back'; cam.t0 = now + BACK_DELAY; }
    return f;
  }
  const k = ease(Math.max(0, Math.min(1, (now - cam.t0) / BACK_TIME)));
  if (k >= 1) { cam.mode = 'full'; cam.c = null; home.classList.remove('busy'); return full; }
  return { x: f.x + (full.x - f.x) * k, y: f.y + (full.y - f.y) * k, s: Math.exp(Math.log(f.s) + (Math.log(full.s) - Math.log(f.s)) * k) };
}

/* ---------- rendu ---------- */
let vw = { x: W / 2, y: H / 2, s: 1 };
function draw(now) {
  vw = view(now);
  const { s } = vw, ox = cv.width / 2 - vw.x * s, oy = cv.height / 2 - vw.y * s;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (const c of chars) {
    for (const { s: sh, body, color } of c.parts) {
      ctx.fillStyle = color;
      const p = body.getPosition(), a = body.getAngle(), co = Math.cos(a) * s, si = Math.sin(a) * s;
      ctx.setTransform(co, si, -si, co, ox + p.x * S * s, oy + p.y * S * s);
      ctx.beginPath();
      if (sh.k === 'circle') ctx.arc(0, 0, sh.w / 2, 0, Math.PI * 2);
      else if (sh.k === 'ellipse') ctx.ellipse(0, 0, sh.w / 2, sh.h / 2, 0, 0, Math.PI * 2);
      else { sh.pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); }
      ctx.fill();
    }
  }
  /* bord de l'affiche, 1 px écran */
  const lw = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = lw; ctx.strokeStyle = '#000';
  ctx.strokeRect(ox + lw / 2, oy + lw / 2, W * s - lw, H * s - lw);
}

let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(now - last, 100); last = now;
  let n = 0;
  while (acc >= STEP * 1000 && n < 8) { step(); acc -= STEP * 1000; n++; }
  if (n === 8) acc = 0;
  draw(now);
  requestAnimationFrame(frame);
}

/* ---------- nom au survol ---------- */
const tip = document.getElementById('tip');
cv.addEventListener('pointermove', e => {
  if (cam.mode !== 'full') { tip.hidden = true; return; }
  const d = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) * d - cv.width / 2) / vw.s + vw.x, y = ((e.clientY - r.top) * d - cv.height / 2) / vw.s + vw.y;
  let hit = null;
  for (let j = chars.length - 1; j >= 0 && !hit; j--)
    for (const { s, body } of chars[j].parts) {
      const p = body.getPosition(), q = rot({ x: x - p.x * S, y: y - p.y * S }, -body.getAngle());
      if (inside(s, q.x, q.y)) { hit = chars[j]; break; }
    }
  tip.hidden = !(hit && hit.name);
  if (!tip.hidden) { tip.textContent = hit.name; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; }
});
cv.addEventListener('pointerleave', () => { tip.hidden = true; });

/* ---------- éditeur de personnage ---------- */
/* balise SVG d'une forme, centrée sur son origine */
function shapeTag(sh, fill) {
  if (sh.k === 'circle') return `<circle r="${fx(sh.w / 2)}" fill="${fill}"/>`;
  if (sh.k === 'ellipse') return `<ellipse rx="${fx(sh.w / 2)}" ry="${fx(sh.h / 2)}" fill="${fill}"/>`;
  return `<polygon points="${sh.pts.map(p => fx(p[0]) + ',' + fx(p[1])).join(' ')}" fill="${fill}"/>`;
}
/* personnage de base : torse rectangle, tête ronde, bras et jambes ovales */
const ed = [
  { k: 'rect', c: '#008bf8' }, { k: 'circle', c: '#f5b700' },
  { k: 'ellipse', c: '#dc0073' }, { k: 'ellipse', c: '#04e762' },
  { k: 'ellipse', c: '#dc0073' }, { k: 'ellipse', c: '#04e762' }
];
const pv = document.getElementById('pv');
/* aperçu à plat : morceaux juxtaposés (petit écart) pour qu'on vise facilement chacun d'eux */
function renderPreview() {
  const s = ed.map((p, i) => { const n = nominal(i, p.k); return shape(null, n.w, n.h, p.k); });
  const T = s[0], g = 0.15, pos = [{ x: 0, y: 0 }, { x: 0, y: T.top - g - s[1].bot }];
  for (const [i, sg] of [[2, -1], [4, 1]]) pos[i] = { x: sg * (T.w / 2 + g + s[i].w / 2), y: T.top + 0.1 - s[i].top };
  for (const [i, sg] of [[3, -1], [5, 1]]) pos[i] = { x: sg * Math.max(T.w * 0.25, s[i].w / 2 + g / 2), y: T.bot + g - s[i].top };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  s.forEach((sh, i) => {
    x0 = Math.min(x0, pos[i].x - sh.w / 2); x1 = Math.max(x1, pos[i].x + sh.w / 2);
    y0 = Math.min(y0, pos[i].y + sh.top);   y1 = Math.max(y1, pos[i].y + sh.bot);
  });
  const m = 0.5; /* marge en haut et en bas seulement : en largeur, le cadre colle au pantin (voir fitMid) */
  pv.setAttribute('viewBox', `${fx(x0)} ${fx(y0 - m)} ${fx(x1 - x0)} ${fx(y1 - y0 + 2 * m)}`);
  pv.innerHTML = s.map((sh, i) => `<g data-p="${i}" transform="translate(${fx(pos[i].x)} ${fx(pos[i].y)})">${shapeTag(sh, ed[i].c)}</g>`).join('');
}
/* sources à glisser : une icône par forme, une pastille par couleur */
const shapesEl = document.getElementById('shapes'), palEl = document.getElementById('pal');
for (const k of KINDS) {
  const n = { square: [1.4, 1.4], rect: [1, 1.8], tri: [1.6, 1.4], circle: [1.6, 1.6], ellipse: [1, 1.8] }[k];
  const el = document.createElement('div');
  el.className = 'src';
  el.innerHTML = `<svg viewBox="-1 -1 2 2">${shapeTag(shape(null, n[0], n[1], k), 'inherit')}</svg>`;
  el.onpointerdown = e => startDrag(e, el, { k });
  shapesEl.appendChild(el);
}
for (const c of PALETTE) {
  const el = document.createElement('div');
  el.className = 'src'; el.style.background = c;
  el.onpointerdown = e => startDrag(e, el, { c });
  palEl.appendChild(el);
}
/* glisser-déposer au pointeur (souris et tactile) : un fantôme suit le pointeur,
   le morceau survolé est surligné, relâcher dessus lui applique la forme ou la couleur */
let drag = null;
function startDrag(e, node, val) {
  e.preventDefault();
  const r = node.getBoundingClientRect(), gh = node.cloneNode(true);
  gh.classList.add('ghost'); gh.style.width = r.width + 'px'; gh.style.height = r.height + 'px';
  document.body.appendChild(gh);
  drag = { gh, val, hot: null };
  moveDrag(e);
}
function moveDrag(e) {
  drag.gh.style.left = e.clientX + 'px'; drag.gh.style.top = e.clientY + 'px';
  const el = document.elementFromPoint(e.clientX, e.clientY), hot = el && el.closest('#pv [data-p]');
  if (hot === drag.hot) return;
  if (drag.hot) drag.hot.classList.remove('hot');
  if (hot) hot.classList.add('hot');
  drag.hot = hot;
}
window.addEventListener('pointermove', e => { if (drag) moveDrag(e); });
window.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.hot) { Object.assign(ed[+drag.hot.dataset.p], drag.val); renderPreview(); }
  drag.gh.remove(); drag = null;
});
window.addEventListener('pointercancel', () => { if (drag) { drag.gh.remove(); drag = null; renderPreview(); } });
renderPreview();
/* la colonne du milieu prend la largeur du pantin affiché : formes et couleurs se centrent
   ainsi entre le bord de l'écran et le pantin. Recalculé à l'ouverture et au redimensionnement
   seulement, pour que rien ne bouge pendant qu'on glisse des formes */
const midEl = document.getElementById('mid');
function fitMid() {
  const [, , w, h] = pv.getAttribute('viewBox').split(' ').map(Number);
  midEl.style.width = '';
  midEl.style.width = Math.max(280, Math.min(pv.clientHeight * w / h, innerWidth * 0.5)) + 'px';
}
window.addEventListener('resize', () => { if (!edEl.hidden) fitMid(); });

/* ---------- nom ---------- */
/* lettres (accents compris), chiffres, espaces et tirets ; mots de 25 lettres max, 40 caractères en tout.
   Le serveur revérifie exactement les mêmes règles */
const nameEl = document.getElementById('name');
const tidy = v => v.normalize('NFC').replace(/[^\p{L}\p{N} -]/gu, '').replace(/^[ -]+/, '').replace(/([ -])[ -]+/g, '$1')
  .split(/([ -])/).map(w => w.slice(0, 25)).join('').slice(0, 40);
const finalName = () => nameEl.value.replace(/[ -]+$/, '');
/* 100 noms dunkerquois pour les carnavaliers aléatoires (sans apostrophe : mêmes règles que les noms saisis) */
const NAMES = ['Jean Bart', 'Reuze', 'Reuzinne', 'Papa Reuze', 'Bande', 'Chapelle', 'Rigodon', 'Chahut', 'Hareng', 'Kipper',
  'Clet', 'Tambour-major', 'Fifre', 'Clique', 'Cantinière', 'Masquelour', 'Visscherbende', 'Cymbalier', 'Lancer de harengs', 'Hôtel de ville',
  'Beffroi', 'Leughenaer', 'Malo-les-Bains', 'Rosendaël', 'Petite-Synthe', 'Grande-Synthe', 'Coudekerque', 'Digue', 'Plage', 'Mer du Nord',
  'Dunes', 'Port', 'Phare', 'Écluse', 'Bassin du commerce', 'Duchesse Anne', 'Princess Elizabeth', 'Môle', 'Estacade', 'Bateau-feu',
  'Sandettie', 'Kursaal', 'Bal du Chat Noir', 'Nuit des Corsaires', 'Bal des Acharnés', 'Bal de la Violette', 'Bal du Cercle', 'Corsaire', 'Flibustier', 'Pêcheur',
  'Islandais', 'Morue', 'Moules frites', 'Potjevleesch', 'Carbonnade', 'Waterzooi', 'Genièvre', 'Chicorée', 'Bière de garde', 'Frite',
  'Parapluie', 'Plumes', 'Perruque', 'Robe de mamie', 'Fourrure', 'Rouge à lèvres', 'Paillettes', 'Masque', 'Confettis', 'Mascarade',
  'Mardi gras', 'Trois Joyeuses', 'Chat noir', 'Violette', 'Acharné', 'Carnavaleux', 'Coucou', 'Vent du nord', 'Bourrasque', 'Marée haute',
  'Mouette', 'Goéland', 'Flandre', 'Westhoek', 'Flamand', 'Opération Dynamo', 'Zuydcoote', 'Bray-Dunes', 'Gravelines', 'Bergues',
  'Saint-Éloi', 'Saint-Pol-sur-Mer', 'Fort-Mardyck', 'Citadelle', 'Jardin de sculptures', 'Grue', 'Cargo', 'Remorqueur', 'Chalutier', 'Marin'];
nameEl.addEventListener('input', () => {
  const v = tidy(nameEl.value);
  if (v !== nameEl.value) nameEl.value = v;
  genBtn.disabled = !finalName();
});

/* ---------- écrans ---------- */
const edEl = document.getElementById('ed'), pop = document.getElementById('pop');
const genBtn = document.getElementById('gen');
let onYes = null;
function ask(msg, yes, fn) {
  document.getElementById('msg').textContent = msg;
  document.getElementById('yes').textContent = yes;
  onYes = fn; pop.hidden = false;
}
function launch(spec) {
  pop.hidden = true; edEl.hidden = true;
  const c = spawn(spec);
  c.mine = true; c.mode = spec ? 'editeur' : 'aleatoire'; c.name =finalName() || (spec ? '' : NAMES[Math.floor(Math.random() * NAMES.length)]);
  nameEl.value = ''; genBtn.disabled = true;
  const p = c.parts[0].body.getPosition();
  Object.assign(cam, { mode: 'follow', c, x: p.x * S, y: p.y * S });
  home.classList.add('busy');
  reste = Math.max(0, reste - 1); showReste();
}
/* un carnavalier par IP (le serveur décide et revérifie) : une fois posé, le bouton laisse place au message */
const joinEl = document.getElementById('join'), doneEl = document.getElementById('done');
let reste = 1;
function showReste() { joinEl.hidden = !reste; doneEl.hidden = !!reste; }
const checkReste = () => fetch('api/reste').then(r => r.json()).then(d => { reste = d.reste; showReste(); });
checkReste().catch(() => {});
/* revérifié juste avant de lancer : un autre onglet ou un autre appareil du même réseau a pu poser entre-temps */
const go = spec => checkReste().catch(() => {}).then(() => {
  if (reste) return launch(spec);
  pop.hidden = true; edEl.hidden = true;
});
joinEl.onclick = () => { if (cam.mode === 'full' && reste) { tip.hidden = true; edEl.hidden = false; fitMid(); } };
genBtn.onclick = () => ask('Ton carnavalier est-il à ton goût ?', 'Générer', () => go(ed.map(p => ({ ...p }))));
document.getElementById('rnd').onclick = () => ask('Un carnavalier aléatoire va être créé. Si tu es sûr de ne pas vouloir créer le tien, appuie sur continuer.', 'Continuer', () => go(null));
document.getElementById('yes').onclick = () => onYes();
document.getElementById('no').onclick = () => { pop.hidden = true; };
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!pop.hidden) pop.hidden = true;
  else edEl.hidden = true;
});

layout();
requestAnimationFrame(frame);
})();
