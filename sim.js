'use strict';
/* =====================================================================
   1G — The Earth–Mars War
   An Expanse-style fleet combat simulation.
   Real scale: meters, seconds, 1g Epstein-drive brachistochrone transits.
   ===================================================================== */

/* ---------------- constants ---------------- */
const TAU = Math.PI * 2;
const AU = 1.496e11;            // m
const G0 = 9.81;                // ship acceleration, m/s^2
const GM_SUN = 1.32712440018e20;

const N_SHIPS    = 12;          // ships per side
const TORP_ACC   = 490;         // torpedo drive, ~50 g
const TORP_AMMO  = 8;           // torpedoes per ship
const SALVO_SIZE = 2;           // torpedoes per ship per salvo
const SALVO_CD   = 55;          // s between salvos
const HIT_R      = 450;         // proximity-fuse radius, m
const STANDOFF   = 2.2e7;       // strike group parks 22,000 km from planet
const PDC_WINDOW = 14;          // s-to-impact at which PDCs engage
const PDC_KPS    = 0.15;        // kill prob / s for a fully engaged torpedo
const PDC_PER_SHIP = 2;         // torpedoes a ship can fully engage at once
const PDC_PLANET_BONUS = 4;     // extra engagement capacity for home fleets

/* ---------------- tiny vector lib ---------------- */
const V    = (x = 0, y = 0) => ({ x, y });
const add  = (a, b) => V(a.x + b.x, a.y + b.y);
const sub  = (a, b) => V(a.x - b.x, a.y - b.y);
const mul  = (a, s) => V(a.x * s, a.y * s);
const len  = a => Math.hypot(a.x, a.y);
const dot  = (a, b) => a.x * b.x + a.y * b.y;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const norm = a => { const l = len(a); return l > 1e-12 ? V(a.x / l, a.y / l) : V(1, 0); };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a, b) => a + Math.random() * (b - a);

/* ---------------- celestial bodies ---------------- */
function makePlanet(name, color, orbitR, ang0deg, drawR, realR) {
  const p = {
    name, color, orbitR, drawR, realR,
    ang0: ang0deg * Math.PI / 180,
    om: Math.sqrt(GM_SUN / (orbitR ** 3)),
    pos: V(), vel: V(),
    update(t) {
      const a = this.ang0 + this.om * t;
      this.pos = V(this.orbitR * Math.cos(a), this.orbitR * Math.sin(a));
      this.vel = V(-this.orbitR * this.om * Math.sin(a), this.orbitR * this.om * Math.cos(a));
    }
  };
  p.update(0);
  return p;
}
const earth = makePlanet('Earth', '#3d7dff', AU,         165, 6, 6.371e6);
const mars  = makePlanet('Mars',  '#ff5a36', 1.524 * AU, 123, 5, 3.39e6);

const SIDES = {
  earth: {
    key: 'earth', navy: 'UNN', color: '#52a7ff', planet: earth, cls: 'e',
    names: ['Agatha King', 'Thomas Prince', 'Tripoli', 'Jimenez', 'Montenegro', 'Kenosha',
            'Sao Paulo', 'Mikhaylov', 'Ottawa', 'Crucible', 'Valiant', 'Prometheus']
  },
  mars: {
    key: 'mars', navy: 'MCRN', color: '#ff6a45', planet: mars, cls: 'm',
    names: ['Donnager', 'Scirocco', 'Hammurabi', 'Xuesen', 'Bahram', 'Sagarmatha',
            'Kittur Chennamma', 'Dushanbe', 'Iani Chaos', 'Karakum', 'Cydonia', 'Vesta']
  }
};
const enemyOf = k => k === 'earth' ? 'mars' : 'earth';

/* ---------------- game state ---------------- */
let simTime = 0;
let timeScale = 1, autoTime = true, paused = false;
let running = false, gameOver = false, gameEndWall = 0, endShown = false;
let GR = null;                  // {earth:{strike,home}, mars:{strike,home}}
let allGroups = [], attackGroups = [], pairCandidates = [];
let battles = [];
let explosions = [];            // {pos, wall0, big}
let captured = { earth: null, mars: null }; // side key of conqueror, or null
let torpId = 0;
let stats = { fired: { earth: 0, mars: 0 }, pdc: { earth: 0, mars: 0 }, lost: { earth: 0, mars: 0 } };
let wallNow = 0;

/* ---------------- logging ---------------- */
const logEntries = [];
let logDirty = false;
function log(msg, cls = 'n') {
  logEntries.push({ t: simTime, msg, cls });
  if (logEntries.length > 80) logEntries.shift();
  logDirty = true;
}

/* ---------------- fleets ---------------- */
function makeGroup(sideKey, role, names, target) {
  const side = SIDES[sideKey];
  return {
    id: sideKey + '-' + role, side: sideKey, role,
    planetHome: side.planet, planetTarget: target,
    ships: names.map((name, fi) => ({ name, fi, alive: true, ammo: TORP_AMMO })),
    count0: names.length,
    pos: V(), vel: V(), fdir: V(1, 0), aim: V(1, 0),
    phase: role === 'defense' ? 'orbit' : 'accel',
    thrusting: false, flipped: false, trail: [], parkOffset: null
  };
}

function buildFleets(allocEarth, allocMars) {
  GR = {};
  for (const [key, n] of [['earth', allocEarth], ['mars', allocMars]]) {
    const side = SIDES[key], tgt = SIDES[enemyOf(key)].planet;
    const strike = makeGroup(key, 'strike', side.names.slice(0, n), tgt);
    const home   = makeGroup(key, 'defense', side.names.slice(n), side.planet);
    const dir = norm(sub(tgt.pos, side.planet.pos));
    strike.pos = add(side.planet.pos, mul(dir, 2.5e7));
    strike.vel = { ...side.planet.vel };
    strike.fdir = dir; strike.aim = dir;
    home.pos = { ...side.planet.pos };
    home.vel = { ...side.planet.vel };
    GR[key] = { strike, home };
  }
  allGroups = [GR.earth.strike, GR.earth.home, GR.mars.strike, GR.mars.home];
  attackGroups = [GR.earth.strike, GR.mars.strike].filter(g => g.count0 > 0);
  // engagements only happen at the planets: each strike force against
  // the defending home fleet of its destination
  pairCandidates = [];
  if (GR.earth.strike.count0 && GR.mars.home.count0) pairCandidates.push([GR.earth.strike, GR.mars.home]);
  if (GR.mars.strike.count0 && GR.earth.home.count0) pairCandidates.push([GR.mars.strike, GR.earth.home]);
}

const aliveCount = g => g.ships.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
const aliveShips = g => g.ships.filter(s => s.alive);
const groupAmmo  = g => g.ships.reduce((n, s) => n + (s.alive ? s.ammo : 0), 0);

function shipPos(g, s) {
  if (g.role === 'defense') {
    const a = (s.fi / Math.max(g.count0, 1)) * TAU + simTime * 3e-5;
    return V(g.pos.x + Math.cos(a) * 1.9e7, g.pos.y + Math.sin(a) * 1.9e7);
  }
  const col = (s.fi / 3) | 0, row = s.fi % 3 - 1;
  const lx = -col * 6e6, ly = row * 7e6;
  const c = g.fdir.x, sn = g.fdir.y;
  return V(g.pos.x + lx * c - ly * sn, g.pos.y + lx * sn + ly * c);
}

/* ---------------- fleet guidance (1g flip-and-burn) ---------------- */
function stepGroup(g, dt) {
  if (g.role === 'defense') {
    g.pos = { ...g.planetHome.pos };
    g.vel = { ...g.planetHome.vel };
    return;
  }
  if (aliveCount(g) === 0) { g.thrusting = false; return; }

  const tp = g.planetTarget;
  if (g.phase === 'parked') {
    g.pos = add(tp.pos, g.parkOffset);
    g.vel = { ...tp.vel };
    g.thrusting = false;
    return;
  }

  const rel = sub(tp.pos, g.pos);
  const d = len(rel) - STANDOFF;
  const rhat = norm(rel);
  const rv = sub(g.vel, tp.vel);          // velocity relative to target planet
  const vAlong = dot(rv, rhat);

  // terminal capture: kill residual velocity, slot into a parking orbit
  if (d < 3e6 && len(rv) < 3000) {
    const dv = G0 * dt;
    if (len(rv) <= dv) {
      g.vel = { ...tp.vel };
      g.phase = 'parked';
      g.parkOffset = sub(g.pos, tp.pos);
      g.thrusting = false;
      log(`${SIDES[g.side].navy} strike group holds station over ${tp.name}`, SIDES[g.side].cls);
    } else {
      g.vel = add(g.vel, mul(norm(rv), -dv));
      g.thrusting = true; g.aim = mul(norm(rv), -1);
    }
    g.pos = add(g.pos, mul(g.vel, dt));
    pushTrail(g);
    return;
  }

  const stop = vAlong > 0 ? vAlong * vAlong / (2 * G0) : 0;
  const wantDecel = g.phase === 'decel'
    ? (vAlong > 0 && stop > 0.90 * d)
    : (vAlong > 0 && stop >= d);

  let thrustDir;
  if (wantDecel) {
    if (!g.flipped) {
      g.flipped = true;
      log(`${SIDES[g.side].navy} strike group flips ship — deceleration burn for ${tp.name}`, SIDES[g.side].cls);
    }
    g.phase = 'decel';
    thrustDir = mul(norm(rv), -1);
  } else {
    g.phase = 'accel';
    const lat = sub(rv, mul(rhat, vAlong));
    const ll = len(lat);
    const corr = ll > 1 ? mul(lat, -Math.min(0.6, ll / 2000) / ll) : V();
    thrustDir = norm(add(rhat, corr));
  }
  g.vel = add(g.vel, mul(thrustDir, G0 * dt));
  g.pos = add(g.pos, mul(g.vel, dt));
  g.thrusting = true;
  g.aim = thrustDir;
  if (len(g.vel) > 100) {
    const vh = norm(sub(g.vel, tp.vel));
    if (len(sub(g.vel, tp.vel)) > 500) g.fdir = vh;
  }
  pushTrail(g);
}

function pushTrail(g) {
  const t = g.trail;
  if (!t.length || dist(t[t.length - 1], g.pos) > 0.004 * AU) {
    t.push({ x: g.pos.x, y: g.pos.y });
    if (t.length > 900) t.shift();
  }
}

/* ---------------- battles ---------------- */
function launchRange(relSpeed) { return 3e7 + relSpeed * 700; }

function battleTitle(a, b) {
  const pl = a.role === 'defense' ? a.planetHome : b.planetHome;
  return 'BATTLE FOR ' + pl.name.toUpperCase();
}

function scanNewBattles() {
  for (const [a, b] of pairCandidates) {
    if (aliveCount(a) === 0 || aliveCount(b) === 0) continue;
    if (battles.some(bt => !bt.done && ((bt.a === a && bt.b === b) || (bt.a === b && bt.b === a)))) continue;
    if (groupAmmo(a) + groupAmmo(b) === 0) continue;
    const d = dist(a.pos, b.pos);
    const rv = sub(b.vel, a.vel);
    const rs = len(rv);
    const closing = -dot(sub(b.pos, a.pos), rv) / Math.max(d, 1);
    if (closing < 1000 && d > 6e7) continue;   // not closing: no (re-)engagement
    if (d < launchRange(rs)) {
      const planet = a.role === 'defense' ? a.planetHome : (b.role === 'defense' ? b.planetHome : null);
      const bt = {
        a, b, planet, title: battleTitle(a, b),
        torps: [], lastSalvo: {}, tIdx: 0,
        dist: d, relSpeed: rs, closing: 0, LR: launchRange(rs),
        minImp: Infinity, lastTorpTime: simTime,
        half: null, done: false, doneWall: 0
      };
      battles.push(bt);
      log(`ENGAGEMENT — ${bt.title}: fleets in torpedo range`, 'sys');
    }
  }
}

function trySalvo(bt, g, enemy) {
  if (aliveCount(g) === 0 || aliveCount(enemy) === 0) return;
  if (bt.dist > bt.LR) return;
  if (bt.closing < -5000 && bt.dist > 1e8) return;            // enemy receding fast
  if (simTime - (bt.lastSalvo[g.id] ?? -1e9) < SALVO_CD) return;
  const targets = aliveShips(enemy);
  let n = 0;
  for (const s of aliveShips(g)) {
    const k = Math.min(SALVO_SIZE, s.ammo);
    for (let i = 0; i < k; i++) {
      s.ammo--;
      const tgt = targets[bt.tIdx++ % targets.length];
      const p0 = shipPos(g, s);
      const aim = norm(sub(shipPos(enemy, tgt), p0));
      bt.torps.push({
        id: torpId++, side: g.side, tGroup: enemy, tShip: tgt,
        pos: p0, vel: add(g.vel, mul(aim, 200)),
        alive: true, age: 0, recede: 0, tImp: Infinity, engaged: false
      });
      n++;
    }
  }
  if (n) {
    bt.lastSalvo[g.id] = simTime;
    bt.lastTorpTime = simTime;
    stats.fired[g.side] += n;
    log(`${SIDES[g.side].navy} ${g.role === 'defense' ? 'home fleet' : 'strike group'} launches ${n} torpedoes`, SIDES[g.side].cls);
  }
}

function updateTorp(bt, t, dt) {
  t.age += dt;
  if (t.age > 2500) { t.alive = false; return; }

  if (!t.tShip.alive) {
    const cands = aliveShips(t.tGroup);
    if (!cands.length) { t.alive = false; return; }
    let best = cands[0], bd = Infinity;
    for (const s of cands) {
      const dd = dist(t.pos, shipPos(t.tGroup, s));
      if (dd < bd) { bd = dd; best = s; }
    }
    t.tShip = best;
  }

  const tpos = shipPos(t.tGroup, t.tShip);
  const tvel = t.tGroup.vel;
  const relP = sub(tpos, t.pos);
  const d = len(relP);
  const relV = sub(tvel, t.vel);
  const closing = -dot(relP, relV) / Math.max(d, 1);
  t.tImp = closing > 1 ? d / closing : Infinity;

  if (closing < 0) { t.recede += dt; if (t.recede > 30) { t.alive = false; return; } }
  else t.recede = 0;

  // proportional pursuit with lead
  const tgo = Math.min(d / Math.max(closing, 100), 900);
  const desired = sub(add(tpos, mul(tvel, tgo)), add(t.pos, mul(t.vel, tgo)));
  const acc = mul(norm(desired), TORP_ACC);

  // integrate + closest-approach hit test within the substep
  const p0 = sub(t.pos, tpos);
  const v0 = add(sub(t.vel, tvel), mul(acc, dt * 0.5));
  t.vel = add(t.vel, mul(acc, dt));
  t.pos = add(t.pos, mul(t.vel, dt));
  const vv = Math.max(dot(v0, v0), 1e-9);
  const tc = clamp(-dot(p0, v0) / vv, 0, dt);
  const cp = add(p0, mul(v0, tc));
  if (len(cp) < HIT_R) {
    t.alive = false;
    // proximity fusing degrades at extreme closing speeds (head-on passes)
    const pk = Math.pow(5e4 / Math.max(len(v0), 5e4), 0.3);
    if (Math.random() < pk) killShip(t.tGroup, t.tShip, tpos);
  }
}

function killShip(g, s, atPos) {
  if (!s.alive) return;
  s.alive = false;
  stats.lost[g.side]++;
  explosions.push({ pos: atPos, wall0: wallNow, big: true });
  log(`${SIDES[g.side].navy} ${s.name} destroyed`, SIDES[g.side].cls);
  if (aliveCount(g) === 0) {
    const what = g.role === 'defense' ? `home fleet over ${g.planetHome.name}` : 'strike group';
    log(`${SIDES[g.side].navy} ${what} ANNIHILATED`, 'sys');
  }
}

function stepPDC(bt, dt) {
  for (const g of [bt.a, bt.b]) {
    const threats = bt.torps.filter(t => t.alive && t.tGroup === g && t.tImp < PDC_WINDOW);
    if (!threats.length) continue;
    const nAlive = aliveCount(g);
    if (!nAlive) continue;
    const cap = nAlive * PDC_PER_SHIP + (g.role === 'defense' ? PDC_PLANET_BONUS : 0);
    const kps = PDC_KPS * Math.min(1, cap / threats.length);
    const p = 1 - Math.exp(-kps * dt);
    for (const t of threats) {
      t.engaged = true;
      if (Math.random() < p) {
        t.alive = false;
        stats.pdc[g.side]++;
        explosions.push({ pos: t.pos, wall0: wallNow, big: false });
      }
    }
  }
}

function stepBattle(bt, dt) {
  const A = bt.a, B = bt.b;
  bt.dist = dist(A.pos, B.pos);
  const rv = sub(B.vel, A.vel);
  bt.relSpeed = len(rv);
  bt.closing = -dot(sub(B.pos, A.pos), rv) / Math.max(bt.dist, 1);
  bt.LR = launchRange(bt.relSpeed);

  trySalvo(bt, A, B);
  trySalvo(bt, B, A);

  bt.minImp = Infinity;
  for (const t of bt.torps) {
    if (!t.alive) continue;
    updateTorp(bt, t, dt);
    if (t.alive && t.tImp < bt.minImp) bt.minImp = t.tImp;
  }
  stepPDC(bt, dt);
  if (bt.torps.length > 600) bt.torps = bt.torps.filter(t => t.alive);
  if (bt.torps.some(t => t.alive)) bt.lastTorpTime = simTime;

  // ---- end conditions (never while torpedoes are still flying) ----
  if (bt.torps.some(t => t.alive)) return;
  const aA = aliveCount(A), aB = aliveCount(B);
  const noAmmo = groupAmmo(A) + groupAmmo(B) === 0;
  const sepThresh = Math.max(6e7, bt.relSpeed * 30);
  let msg = null;
  if (aA === 0 && aB === 0) msg = 'mutual destruction — no survivors';
  else if (aA === 0) msg = `${SIDES[B.side].navy} holds the field`;
  else if (aB === 0) msg = `${SIDES[A.side].navy} holds the field`;
  else if (bt.closing < -1000 && bt.dist > sepThresh) msg = 'fleets disengage at extreme range';
  else if (noAmmo && simTime - bt.lastTorpTime > 120) msg = 'magazines dry — uneasy standoff';
  if (msg) {
    bt.done = true;
    bt.doneWall = wallNow;
    log(`${bt.title} — ${msg}`, 'sys');
  }
}

/* ---------------- captures & endgame ---------------- */
function checkCaptures() {
  for (const g of attackGroups) {
    if (g.phase !== 'parked' || aliveCount(g) === 0) continue;
    const tgtKey = enemyOf(g.side);
    if (captured[tgtKey]) continue;
    if (aliveCount(GR[tgtKey].home) > 0) continue;
    if (battles.some(bt => !bt.done && (bt.a === g || bt.b === g))) continue;
    captured[tgtKey] = g.side;
    log(`${SIDES[tgtKey].planet.name.toUpperCase()} HAS FALLEN — ${SIDES[g.side].navy} controls its orbitals`, 'sys');
  }
}

function checkGameOver() {
  if (gameOver || !running) return;
  const resolved = attackGroups.every(g => aliveCount(g) === 0 || g.phase === 'parked');
  const quiet = battles.every(bt => bt.done);
  if (resolved && quiet) {
    gameOver = true;
    gameEndWall = wallNow;
    log('— SIMULATION COMPLETE —', 'sys');
  }
}

function showEndScreen() {
  const eFell = captured.earth, mFell = captured.mars;
  const T = document.getElementById('endTitle'), S = document.getElementById('endSub');
  if (eFell && mFell) {
    T.textContent = 'MUTUAL CONQUEST'; T.className = 'amberC';
    S.innerHTML = 'Both homeworlds have fallen to the other\'s strike force.<br>Two flags over two broken worlds.';
  } else if (eFell) {
    T.textContent = 'MARS VICTORIOUS'; T.className = 'marsC';
    S.innerHTML = 'The MCRN strike force holds Earth orbit unopposed.';
  } else if (mFell) {
    T.textContent = 'EARTH VICTORIOUS'; T.className = 'earthC';
    S.innerHTML = 'The UNN strike force holds Mars orbit unopposed.';
  } else if (stats.fired.earth + stats.fired.mars === 0) {
    T.textContent = 'COLD STANDOFF'; T.className = 'amberC';
    S.innerHTML = 'Neither commander committed ships to the attack.<br>The war never started.';
  } else {
    T.textContent = 'STALEMATE'; T.className = 'amberC';
    const eAtt = GR.earth.strike.count0 > 0, mAtt = GR.mars.strike.count0 > 0;
    S.innerHTML = eAtt && mAtt
      ? 'Both assaults were repelled. The homeworlds endure.'
      : `The assault on ${eAtt ? 'Mars' : 'Earth'} was repelled. The homeworlds endure.`;
  }
  document.getElementById('endStats').textContent =
    `Mission time        ${fmtTime(simTime)}\n` +
    `UNN ships lost      ${stats.lost.earth} of ${N_SHIPS}\n` +
    `MCRN ships lost     ${stats.lost.mars} of ${N_SHIPS}\n` +
    `Torpedoes fired     UNN ${stats.fired.earth} · MCRN ${stats.fired.mars}\n` +
    `PDC intercepts      UNN ${stats.pdc.earth} · MCRN ${stats.pdc.mars}`;
  showScreen('s-end');
  document.getElementById('overlay').style.display = 'flex';
}

/* ---------------- physics master step ---------------- */
function stepPhysics(h) {
  simTime += h;
  earth.update(simTime);
  mars.update(simTime);
  for (const g of allGroups) stepGroup(g, h);
  for (const bt of battles) if (!bt.done) stepBattle(bt, h);
  scanNewBattles();
  checkCaptures();
}

/* ---------------- adaptive time warp ---------------- */
function upcomingEventDt() {
  let next = Infinity;
  for (const [a, b] of pairCandidates) {
    if (aliveCount(a) === 0 || aliveCount(b) === 0) continue;
    if (groupAmmo(a) + groupAmmo(b) === 0) continue;
    if (battles.some(bt => !bt.done && ((bt.a === a && bt.b === b) || (bt.a === b && bt.b === a)))) continue;
    const d = dist(a.pos, b.pos);
    const rv = sub(b.vel, a.vel);
    const closing = -dot(sub(b.pos, a.pos), rv) / Math.max(d, 1);
    if (closing > 1) next = Math.min(next, (d - launchRange(len(rv))) / closing);
  }
  for (const g of attackGroups) {
    if (aliveCount(g) === 0 || g.phase === 'parked') continue;
    const d = Math.max(dist(g.pos, g.planetTarget.pos) - STANDOFF, 0);
    const v = len(sub(g.vel, g.planetTarget.vel));
    const tArr = g.phase === 'decel'
      ? v / G0
      : ((Math.sqrt(v * v + 2 * G0 * d) - v) / G0) * 1.6;
    next = Math.min(next, tArr + 60);
  }
  return next;
}

function desiredTimeScale() {
  if (gameOver) return 30;
  const active = battles.filter(bt => !bt.done);
  if (active.length) {
    let minImp = Infinity;
    for (const bt of active) minImp = Math.min(minImp, bt.minImp);
    if (minImp < 4) return 3;
    if (minImp < 12) return 10;
    if (minImp < 40) return 35;
    return 120;
  }
  const next = upcomingEventDt();
  if (!isFinite(next)) return 400;
  return clamp(next / 3, 30, 120000);
}

/* ===================================================================
   RENDERING
   =================================================================== */
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, stars = [];

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  stars = [];
  for (let i = 0; i < 350; i++)
    stars.push({ x: Math.random() * W, y: Math.random() * H, r: rand(0.3, 1.3), tw: rand(0.5, 3), ph: rand(0, TAU) });
}
window.addEventListener('resize', resize);
resize();

function worldScale() { return Math.min(W, H) / (3.45 * AU); }
function w2s(p) { const s = worldScale(); return V(W / 2 + p.x * s, H / 2 + p.y * s); }

function drawShipTri(x, y, ang, size, color) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.55);
  ctx.lineTo(-size * 0.4, 0);
  ctx.lineTo(-size * 0.7, -size * 0.55);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawWorld() {
  ctx.fillStyle = '#04060d';
  ctx.fillRect(0, 0, W, H);

  // stars
  for (const st of stars) {
    ctx.globalAlpha = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(wallNow * st.tw + st.ph));
    ctx.fillStyle = '#cfe0ff';
    ctx.fillRect(st.x, st.y, st.r, st.r);
  }
  ctx.globalAlpha = 1;

  const s = worldScale();

  // orbits
  ctx.strokeStyle = 'rgba(160,190,255,0.09)';
  ctx.lineWidth = 1;
  for (const p of [earth, mars]) {
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, p.orbitR * s, 0, TAU);
    ctx.stroke();
  }

  // sun
  const sg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 26);
  sg.addColorStop(0, 'rgba(255,240,200,1)');
  sg.addColorStop(0.3, 'rgba(255,200,110,0.7)');
  sg.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 26, 0, TAU); ctx.fill();

  // trails
  if (GR) for (const g of attackGroups) {
    if (g.trail.length < 2) continue;
    ctx.strokeStyle = SIDES[g.side].color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const p0 = w2s(g.trail[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < g.trail.length; i++) { const p = w2s(g.trail[i]); ctx.lineTo(p.x, p.y); }
    const pe = w2s(g.pos); ctx.lineTo(pe.x, pe.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // planets
  for (const p of [earth, mars]) {
    const sp = w2s(p.pos);
    const gl = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, p.drawR * 3.2);
    gl.addColorStop(0, p.color);
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.5; ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, p.drawR * 3.2, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, p.drawR, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(200,220,255,0.65)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(p.name.toUpperCase(), sp.x, sp.y - p.drawR - 7);
  }

  if (!GR) return;

  // defense fleets (markers near planets)
  for (const key of ['earth', 'mars']) {
    const g = GR[key].home;
    if (g.count0 === 0) continue;
    const n = aliveCount(g);
    const sp = w2s(g.pos);
    if (n > 0) {
      ctx.strokeStyle = SIDES[key].color;
      ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
      ctx.strokeRect(sp.x - 4, sp.y + 9, 8, 8);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = n > 0 ? SIDES[key].color : '#5a6a85';
    ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText(n > 0 ? `HOME ${n}` : 'HOME ✕', sp.x, sp.y + 28);
  }

  // strike fleets
  for (const g of attackGroups) {
    if (aliveCount(g) === 0) continue;
    const sp = w2s(g.pos);
    const ang = Math.atan2(g.aim.y, g.aim.x);
    if (g.thrusting) {
      const L = 10 + Math.random() * 7;
      ctx.strokeStyle = 'rgba(170,220,255,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sp.x - Math.cos(ang) * 6, sp.y - Math.sin(ang) * 6);
      ctx.lineTo(sp.x - Math.cos(ang) * (6 + L), sp.y - Math.sin(ang) * (6 + L));
      ctx.stroke();
    }
    drawShipTri(sp.x, sp.y, ang, 7, SIDES[g.side].color);
    ctx.fillStyle = SIDES[g.side].color;
    ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${SIDES[g.side].navy} ${aliveCount(g)}`, sp.x, sp.y - 12);
  }

  // battle reticles
  for (const bt of battles) {
    if (bt.done) continue;
    const c = w2s(mul(add(bt.a.pos, bt.b.pos), 0.5));
    const r = 16 + 5 * Math.sin(wallNow * 5);
    ctx.strokeStyle = 'rgba(255,210,127,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }

  // world-view explosions
  for (const ex of explosions) {
    const age = wallNow - ex.wall0;
    if (age > 1.2) continue;
    const sp = w2s(ex.pos);
    ctx.globalAlpha = 1 - age / 1.2;
    ctx.strokeStyle = '#ffd9a0';
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 2 + age * (ex.big ? 14 : 7), 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/* ---------------- battle insets ---------------- */
function activeInsets() {
  return battles.filter(bt => !bt.done || wallNow - bt.doneWall < 2.5).slice(-2);
}

function drawInset(bt, ix, iy, isz, dtWall) {
  const cw = mul(add(bt.a.pos, bt.b.pos), 0.5);
  const sep = dist(bt.a.pos, bt.b.pos);
  const targetHalf = Math.max(sep * 0.62, 3.2e7);
  bt.half = bt.half == null ? targetHalf : lerp(bt.half, targetHalf, 1 - Math.exp(-1.8 * dtWall));
  const half = bt.half;
  const si = (isz / 2 - 14) / half;
  const cx = ix + isz / 2, cy = iy + isz / 2;
  const toI = p => V(cx + (p.x - cw.x) * si, cy + (p.y - cw.y) * si);

  // connector to world position
  const wc = w2s(cw);
  ctx.strokeStyle = 'rgba(255,210,127,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(wc.x, wc.y); ctx.lineTo(cx, iy); ctx.stroke();

  // frame
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(ix, iy, isz, isz, 8); else ctx.rect(ix, iy, isz, isz);
  ctx.fillStyle = 'rgba(4,8,18,0.93)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,160,230,0.45)';
  ctx.stroke();
  ctx.clip();

  // range rings
  const ringStep = Math.pow(10, Math.floor(Math.log10(half)));
  ctx.strokeStyle = 'rgba(120,160,230,0.12)';
  ctx.font = '8px monospace'; ctx.textAlign = 'left';
  for (let r = ringStep; r < half * 1.4; r += ringStep) {
    ctx.beginPath(); ctx.arc(cx, cy, r * si, 0, TAU); ctx.stroke();
    if (r * si > 30) {
      ctx.fillStyle = 'rgba(120,160,230,0.3)';
      ctx.fillText(fmtKm(r), cx + r * si * 0.707 + 2, cy - r * si * 0.707);
    }
  }

  // planet
  if (bt.planet && dist(bt.planet.pos, cw) < half * 1.8) {
    const pp = toI(bt.planet.pos);
    const pr = Math.max(bt.planet.realR * si, 2);
    const gl = ctx.createRadialGradient(pp.x, pp.y, pr * 0.5, pp.x, pp.y, pr * 1.25);
    gl.addColorStop(0, bt.planet.color);
    gl.addColorStop(0.8, bt.planet.color);
    gl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(pp.x, pp.y, pr * 1.25, 0, TAU); ctx.fill();
  }

  const frameVel = mul(add(bt.a.vel, bt.b.vel), 0.5);

  // PDC tracers
  for (const t of bt.torps) {
    if (!t.alive || !t.engaged) continue;
    const defenders = aliveShips(t.tGroup);
    if (!defenders.length) continue;
    const src = defenders[(t.id * 7 + Math.floor(wallNow * 9)) % defenders.length];
    const a = toI(shipPos(t.tGroup, src)), b = toI(t.pos);
    ctx.strokeStyle = 'rgba(255,224,138,' + rand(0.15, 0.5).toFixed(2) + ')';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x + rand(-3, 3), b.y + rand(-3, 3));
    ctx.stroke();
  }

  // torpedoes
  for (const t of bt.torps) {
    if (!t.alive) continue;
    const p = toI(t.pos);
    const rv = sub(t.vel, frameVel);
    const p2 = toI(add(t.pos, mul(norm(rv), -10 / si)));
    ctx.strokeStyle = t.side === 'earth' ? 'rgba(140,200,255,0.7)' : 'rgba(255,170,130,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p2.x, p2.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.fillStyle = t.side === 'earth' ? '#bfe0ff' : '#ffc4a8';
    ctx.fillRect(p.x - 1, p.y - 1, 2.2, 2.2);
  }

  // ships
  for (const g of [bt.a, bt.b]) {
    const other = g === bt.a ? bt.b : bt.a;
    for (const sh of aliveShips(g)) {
      const p = toI(shipPos(g, sh));
      let ang;
      if (g.role === 'defense') {
        const d = sub(other.pos, g.pos);
        ang = Math.atan2(d.y, d.x);
      } else ang = Math.atan2(g.aim.y, g.aim.x);
      drawShipTri(p.x, p.y, ang, 4.5, SIDES[g.side].color);
      if (g.role !== 'defense' && g.thrusting) {
        ctx.strokeStyle = 'rgba(170,220,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - Math.cos(ang) * 4, p.y - Math.sin(ang) * 4);
        ctx.lineTo(p.x - Math.cos(ang) * (8 + Math.random() * 5), p.y - Math.sin(ang) * (8 + Math.random() * 5));
        ctx.stroke();
      }
    }
  }

  // explosions inside inset
  for (const ex of explosions) {
    const age = wallNow - ex.wall0;
    if (age > 1.0) continue;
    if (dist(ex.pos, cw) > half * 1.5) continue;
    const p = toI(ex.pos);
    const r = 2 + age * (ex.big ? 22 : 9);
    ctx.globalAlpha = (1 - age) * 0.9;
    ctx.fillStyle = '#fff1d0';
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3 - age * 3, 0.5), 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ffb85a';
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // header & counts
  ctx.fillStyle = 'rgba(8,14,30,0.9)';
  ctx.fillRect(ix, iy, isz, 18);
  ctx.fillStyle = '#ffd27f';
  ctx.font = '10px monospace'; ctx.textAlign = 'center';
  ctx.fillText(bt.title, cx, iy + 12);
  ctx.textAlign = 'left';
  ctx.fillStyle = SIDES[bt.a.side].color;
  ctx.fillText(`${SIDES[bt.a.side].navy} ${aliveCount(bt.a)}`, ix + 8, iy + isz - 8);
  ctx.textAlign = 'right';
  ctx.fillStyle = SIDES[bt.b.side].color;
  ctx.fillText(`${aliveCount(bt.b)} ${SIDES[bt.b.side].navy}`, ix + isz - 8, iy + isz - 8);
  ctx.restore();
}

/* ---------------- HUD ---------------- */
const $ = id => document.getElementById(id);

function fmtTime(t) {
  t = Math.max(0, Math.floor(t));
  const d = Math.floor(t / 86400);
  const h = String(Math.floor(t / 3600) % 24).padStart(2, '0');
  const m = String(Math.floor(t / 60) % 60).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${d}d ${h}:${m}:${s}`;
}
function fmtScale(x) {
  return '×' + (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));
}
function fmtKm(m) {
  const km = m / 1000;
  if (km >= 1e6) return (km / 1e6).toFixed(1) + 'M km';
  if (km >= 1e3) return Math.round(km / 1e3) + 'k km';
  return Math.round(km) + ' km';
}
const PHASE_LABEL = { accel: 'ACCEL 1g ▸', decel: 'DECEL 1g ◂', parked: 'ON STATION', orbit: 'IN ORBIT' };

function panelHTML(key) {
  const side = SIDES[key];
  const strike = GR[key].strike, home = GR[key].home;
  let out = `<div class="hdr">${side.navy} · ${side.planet.name.toUpperCase()}</div>`;
  if (strike.count0 === 0) {
    out += `<span class="dim">STRIKE  — none committed</span>\n`;
  } else {
    const n = aliveCount(strike);
    if (n === 0) out += `STRIKE  <span class="dim">0/${strike.count0} — DESTROYED</span>\n`;
    else {
      const v = len(sub(strike.vel, strike.planetTarget.vel));
      const d = dist(strike.pos, strike.planetTarget.pos);
      out += `STRIKE  ${n}/${strike.count0}  ${PHASE_LABEL[strike.phase] || ''}\n`;
      out += `<span class="dim">  v ${(v / 1000).toFixed(1)} km/s · ${(d / AU).toFixed(2)} AU to ${strike.planetTarget.name}</span>\n`;
    }
  }
  if (home.count0 === 0) out += `<span class="dim">HOME    — none held back</span>\n`;
  else {
    const n = aliveCount(home);
    out += n === 0
      ? `HOME    <span class="dim">0/${home.count0} — DESTROYED</span>\n`
      : `HOME    ${n}/${home.count0} · ${side.planet.name} orbit\n`;
  }
  out += `<span class="dim">TORPS   ${groupAmmo(strike) + groupAmmo(home)} in tubes · ${stats.fired[key]} fired</span>`;
  return out;
}

let hudTimer = 0;
function updateHUD(dtWall) {
  hudTimer -= dtWall;
  if (hudTimer > 0) return;
  hudTimer = 0.12;
  $('clock').textContent = 'T+ ' + fmtTime(simTime);
  $('tscale').textContent = paused
    ? '— PAUSED —'
    : `TIME ${fmtScale(timeScale)} · ${autoTime ? 'AUTO' : 'MANUAL'}`;
  $('panelL').innerHTML = panelHTML('earth');
  $('panelR').innerHTML = panelHTML('mars');
  if (logDirty) {
    logDirty = false;
    $('log').innerHTML = logEntries.slice(-9).map(e =>
      `<div class="lg ${e.cls}"><span class="ts">T+${fmtTime(e.t)}</span>${e.msg}</div>`).join('');
  }
}

/* ---------------- main loop ---------------- */
let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dtWall = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;
  wallNow = now / 1000;

  if (running && !paused && !gameOver) {
    if (autoTime) {
      const target = desiredTimeScale();
      timeScale = Math.exp(lerp(Math.log(timeScale), Math.log(target), 1 - Math.exp(-2.5 * dtWall)));
    }
    let remaining = dtWall * timeScale;
    let guard = 0;
    const hadBattle = battles.some(bt => !bt.done);
    let nearDist = Infinity;
    for (const g of attackGroups)
      if (aliveCount(g) && g.phase !== 'parked')
        nearDist = Math.min(nearDist, dist(g.pos, g.planetTarget.pos));
    while (remaining > 1e-9 && guard++ < 500) {
      const inBattle = battles.some(bt => !bt.done);
      let maxStep = inBattle ? 0.5 : 20;
      if (!inBattle && nearDist < 5e8) maxStep = 4;
      const h = Math.min(remaining, maxStep);
      stepPhysics(h);
      remaining -= h;
      if (!hadBattle && battles.some(bt => !bt.done)) break;  // a battle just started: stop warping past it
    }
    checkGameOver();
  }

  if (explosions.length > 200) explosions = explosions.filter(e => wallNow - e.wall0 < 1.5);

  drawWorld();

  if (running) {
    const ins = activeInsets();
    const isz = Math.min(340, W * 0.42, H * 0.46);
    ins.forEach((bt, i) => {
      const ix = i === 0 ? 14 : W - isz - 14;
      drawInset(bt, ix, H - isz - 40, isz, dtWall);
    });
    updateHUD(dtWall);
    if (gameOver && !endShown && wallNow - gameEndWall > 3.2) {
      endShown = true;
      showEndScreen();
    }
  }
}
requestAnimationFrame(frame);

/* ---------------- keyboard ---------------- */
window.addEventListener('keydown', e => {
  if (!running) return;
  if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') { autoTime = false; timeScale = clamp(timeScale * 2, 0.5, 2e5); }
  else if (e.key === '-' || e.key === '_') { autoTime = false; timeScale = clamp(timeScale / 2, 0.5, 2e5); }
  else if (e.key === 'a' || e.key === 'A') autoTime = true;
});

/* ---------------- setup flow ---------------- */
let allocPhase = 'earth';
const alloc = { earth: 8, mars: 8 };

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

function refreshAllocScreen() {
  const side = SIDES[allocPhase];
  $('allocTitle').textContent = `${side.navy} COMMAND — ${side.planet.name.toUpperCase()}`;
  $('allocTitle').className = allocPhase === 'earth' ? 'earthC' : 'marsC';
  $('allocSub').innerHTML =
    `Commander, divide your <b>${N_SHIPS} warships</b>.<br>` +
    `The strike force burns at 1g for <b>${SIDES[enemyOf(allocPhase)].planet.name}</b>; ` +
    `the home fleet holds your orbitals. Your choice stays sealed.`;
  const att = +$('allocSlider').value, def = N_SHIPS - att;
  const col = side.color;
  $('allocReadout').innerHTML =
    `STRIKE FORCE &nbsp;<span class="ships" style="color:${col}">${'▲'.repeat(att) || '—'}</span>&nbsp; ${att}<br>` +
    `HOME FLEET &nbsp;&nbsp;&nbsp;<span class="ships" style="color:${col}">${'△'.repeat(def) || '—'}</span>&nbsp; ${def}`;
}

$('btnBegin').onclick = () => { allocPhase = 'earth'; $('allocSlider').value = 8; refreshAllocScreen(); showScreen('s-alloc'); };
$('allocSlider').oninput = refreshAllocScreen;
$('btnCommit').onclick = () => {
  alloc[allocPhase] = +$('allocSlider').value;
  if (allocPhase === 'earth') {
    allocPhase = 'mars';
    showScreen('s-handoff');
  } else {
    startSim();
  }
};
$('btnHandoff').onclick = () => { $('allocSlider').value = 8; refreshAllocScreen(); showScreen('s-alloc'); };
$('btnAgain').onclick = () => location.reload();

function startSim() {
  buildFleets(alloc.earth, alloc.mars);
  $('overlay').style.display = 'none';
  $('hud').hidden = false;
  simTime = 0; timeScale = 1; autoTime = true; paused = false;
  running = true;
  log('WAR DECLARED — both fleets light their Epstein drives', 'sys');
  for (const key of ['earth', 'mars']) {
    const s = SIDES[key];
    if (alloc[key] > 0)
      log(`${s.navy} strike group (${alloc[key]} ships) departs ${s.planet.name} — 1g burn`, s.cls);
    else
      log(`${s.navy} commits no ships to the attack — full defensive posture`, s.cls);
    if (N_SHIPS - alloc[key] > 0)
      log(`${s.navy} home fleet (${N_SHIPS - alloc[key]} ships) holds ${s.planet.name} orbit`, s.cls);
  }
}
