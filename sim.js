'use strict';
/* =====================================================================
   1G — The Earth–Mars War
   A hard-SF fleet combat simulation.
   Real scale: meters, seconds, 1g torch-drive brachistochrone transits.
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
const RAD   = Math.PI / 180;

/* ---------------- celestial bodies ---------------- */
// Keplerian ellipse around the Sun (focus at the origin).
// a: semi-major axis, ecc: eccentricity, varpi: longitude of perihelion,
// M0: mean anomaly at t=0, mu: the body's own GM (for ships orbiting it).
function makePlanet(name, color, a, ecc, varpi, M0, drawR, realR, mu) {
  const p = {
    name, color, a, ecc, varpi, M0, drawR, realR, mu,
    n: Math.sqrt(GM_SUN / (a ** 3)),
    b: a * Math.sqrt(1 - ecc * ecc),
    colR: realR * 1.04,
    pos: V(), vel: V(), moons: [],
    update(t) {
      const M = this.M0 + this.n * t;
      let E = M;                                     // Kepler: M = E - e sin E
      for (let i = 0; i < 6; i++)
        E -= (E - this.ecc * Math.sin(E) - M) / (1 - this.ecc * Math.cos(E));
      const cE = Math.cos(E), sE = Math.sin(E);
      const xp = this.a * (cE - this.ecc), yp = this.b * sE;
      const Ed = this.n / (1 - this.ecc * cE);
      const vxp = -this.a * sE * Ed, vyp = this.b * cE * Ed;
      const cw = Math.cos(this.varpi), sw = Math.sin(this.varpi);
      this.pos = V(xp * cw - yp * sw, xp * sw + yp * cw);
      this.vel = V(vxp * cw - vyp * sw, vxp * sw + vyp * cw);
      for (const m of this.moons) m.update(t);
    }
  };
  p.update(0);
  return p;
}

// circular orbit around a parent planet
function makeMoon(name, color, parent, a, mu, drawR, realR, colR, ang0) {
  const m = {
    name, color, parent, a, mu, drawR, realR, colR, ang0,
    om: Math.sqrt(parent.mu / (a ** 3)),
    pos: V(), vel: V(),
    update(t) {
      const th = this.ang0 + this.om * t;
      this.pos = V(parent.pos.x + this.a * Math.cos(th), parent.pos.y + this.a * Math.sin(th));
      this.vel = V(parent.vel.x - this.a * this.om * Math.sin(th),
                   parent.vel.y + this.a * this.om * Math.cos(th));
    }
  };
  parent.moons.push(m);
  m.update(0);
  return m;
}

const earth = makePlanet('Earth', '#3d7dff', AU,            0.0167, 103 * RAD, 1.0526, 6, 6.371e6, 3.986004418e14);
const mars  = makePlanet('Mars',  '#ff5a36', 1.523679 * AU, 0.0934, 336 * RAD, 2.4639, 5, 3.39e6,  4.2828e13);
const luna   = makeMoon('Luna',   '#9aa3b8', earth, 3.844e8,  4.9048e12, 2.5, 1.7374e6, 1.85e6, 0.9);
const phobos = makeMoon('Phobos', '#8a7d72', mars,  9.376e6,  0,         1.5, 1.1e4,    2.5e4,  2.1);
const deimos = makeMoon('Deimos', '#8a7d72', mars,  2.3463e7, 0,         1.5, 6.2e3,    2e4,    4.4);

// bodies that pull on ships & torpedoes / that torpedoes can crash into
const GRAV_BODIES = [earth, mars, luna];
const COLLIDERS = [earth, mars, luna, phobos, deimos];

function gravAt(p) {
  let r2 = p.x * p.x + p.y * p.y, r = Math.sqrt(r2);
  let s = -GM_SUN / (r2 * r);
  let ax = p.x * s, ay = p.y * s;
  for (const b of GRAV_BODIES) {
    const dx = b.pos.x - p.x, dy = b.pos.y - p.y;
    r2 = dx * dx + dy * dy; r = Math.sqrt(r2);
    if (r < b.realR) continue;
    s = b.mu / (r2 * r);
    ax += dx * s; ay += dy * s;
  }
  return V(ax, ay);
}

// is the segment p1→p2 clear of every body? (planets & moons block fire)
function losClear(p1, p2) {
  const ab = sub(p2, p1);
  const den = Math.max(dot(ab, ab), 1e-9);
  for (const c of COLLIDERS) {
    const tt = clamp(dot(sub(c.pos, p1), ab) / den, 0, 1);
    if (dist(add(p1, mul(ab, tt)), c.pos) < c.colR * 1.05) return false;
  }
  return true;
}

const SIDES = {
  earth: {
    key: 'earth', navy: 'PFE', fullName: "People's Fleet of Earth",
    color: '#52a7ff', planet: earth, moons: [luna], cls: 'e',
    names: ['Meridian', 'Concord', 'Stalwart', 'Aegis', 'Endeavour', 'Lodestar',
            'Sentinel', 'Bastion', 'Resolute', 'Vanguard', 'Tempest', 'Horizon']
  },
  mars: {
    key: 'mars', navy: 'UMSF', fullName: 'United Mars Space Force',
    color: '#ff6a45', planet: mars, moons: [deimos, phobos], cls: 'm',
    names: ['Olympus', 'Tharsis', 'Valles', 'Ares', 'Acidalia', 'Hellas',
            'Elysium', 'Arcadia', 'Solis', 'Argyre', 'Utopia', 'Syrtis']
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
const R_DEF = 1.9e7;            // home-fleet circular orbit radius

function makeGroup(sideKey, role, names, target) {
  const side = SIDES[sideKey];
  return {
    id: sideKey + '-' + role, side: sideKey, role,
    planetHome: side.planet, planetTarget: target,
    ships: names.map((name, fi) => ({ name, fi, alive: true, ammo: TORP_AMMO })),
    count0: names.length,
    pos: V(), vel: V(), fdir: V(1, 0), aim: V(1, 0),
    phase: role === 'strike' ? 'accel' : 'orbit',
    thrusting: false, flipped: false, trail: []
  };
}

// how a side's picket ships are spread over its moons
function picketPlan(key, nPicket) {
  const moons = SIDES[key].moons;
  if (moons.length === 1) return [{ moon: moons[0], n: nPicket }];
  const first = Math.ceil(nPicket / 2);          // outer moon gets the larger half
  return [{ moon: moons[0], n: first }, { moon: moons[1], n: nPicket - first }];
}

function buildFleets(allocEarth, allocMars) {
  GR = {};
  for (const [key, n] of [['earth', allocEarth], ['mars', allocMars]]) {
    const side = SIDES[key], tgt = SIDES[enemyOf(key)].planet;
    const nDef = N_SHIPS - n;
    const nPicket = Math.floor(nDef / 3);   // a third of the defenders picket the moons
    const strike = makeGroup(key, 'strike', side.names.slice(0, n), tgt);
    const home   = makeGroup(key, 'defense', side.names.slice(n, n + nDef - nPicket), side.planet);
    const dir = norm(sub(tgt.pos, side.planet.pos));
    strike.pos = add(side.planet.pos, mul(dir, 2.5e7));
    strike.vel = { ...side.planet.vel };
    strike.fdir = dir; strike.aim = dir;
    home.pos = { ...side.planet.pos };
    home.vel = { ...side.planet.vel };
    home.ringOm = Math.sqrt(side.planet.mu / R_DEF ** 3);
    const pickets = [];
    let taken = N_SHIPS - nPicket;
    for (const { moon, n: np } of picketPlan(key, nPicket)) {
      if (!np) continue;
      const picket = makeGroup(key, 'picket', side.names.slice(taken, taken + np), side.planet);
      taken += np;
      picket.moon = moon;
      picket.mode = 'station';
      // real orbit around a massive moon; powered loiter near a tiny one
      picket.ringR = moon.mu > 1e9 ? 3.5e6 : 8e5;
      picket.ringOm = moon.mu > 1e9 ? Math.sqrt(moon.mu / picket.ringR ** 3) : 1.5e-4;
      picket.pos = { ...moon.pos };
      picket.vel = { ...moon.vel };
      pickets.push(picket);
    }
    GR[key] = { strike, home, pickets };
  }
  allGroups = [GR.earth.strike, GR.earth.home, ...GR.earth.pickets,
               GR.mars.strike, GR.mars.home, ...GR.mars.pickets];
  attackGroups = [GR.earth.strike, GR.mars.strike].filter(g => g.count0 > 0);
  // engagements happen at the planets: each strike force against the
  // defending home fleet and moon pickets of its destination
  pairCandidates = [];
  for (const key of ['earth', 'mars']) {
    const st = GR[key].strike, foe = GR[enemyOf(key)];
    if (!st.count0) continue;
    if (foe.home.count0) pairCandidates.push([st, foe.home]);
    for (const p of foe.pickets) pairCandidates.push([st, p]);
  }
}

const aliveCount = g => g.ships.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
const aliveShips = g => g.ships.filter(s => s.alive);
const groupAmmo  = g => g.ships.reduce((n, s) => n + (s.alive ? s.ammo : 0), 0);

const ringAngle = (g, s) => (s.fi / Math.max(g.count0, 1)) * TAU + g.ringOm * simTime;

function shipPos(g, s) {
  if (g.role === 'defense') {
    const a = ringAngle(g, s);
    return V(g.planetHome.pos.x + R_DEF * Math.cos(a), g.planetHome.pos.y + R_DEF * Math.sin(a));
  }
  if (g.role === 'picket' && g.mode === 'station') {
    const a = ringAngle(g, s);
    return V(g.moon.pos.x + g.ringR * Math.cos(a), g.moon.pos.y + g.ringR * Math.sin(a));
  }
  if (g.role === 'strike' && g.phase === 'parked') {
    const a = g.parkAng0 + g.parkOm * (simTime - g.parkT0) + (s.fi - (g.count0 - 1) / 2) * 0.025;
    const tp = g.planetTarget;
    return V(tp.pos.x + g.parkR * Math.cos(a), tp.pos.y + g.parkR * Math.sin(a));
  }
  const col = (s.fi / 3) | 0, row = s.fi % 3 - 1;
  const lx = -col * 6e6, ly = row * 7e6;
  const c = g.fdir.x, sn = g.fdir.y;
  return V(g.pos.x + lx * c - ly * sn, g.pos.y + lx * sn + ly * c);
}

function shipVel(g, s) {
  if (g.role === 'defense') {
    const a = ringAngle(g, s), vt = R_DEF * g.ringOm;
    return V(g.planetHome.vel.x - vt * Math.sin(a), g.planetHome.vel.y + vt * Math.cos(a));
  }
  if (g.role === 'picket' && g.mode === 'station') {
    const a = ringAngle(g, s), vt = g.ringR * g.ringOm;
    return V(g.moon.vel.x - vt * Math.sin(a), g.moon.vel.y + vt * Math.cos(a));
  }
  if (g.role === 'strike' && g.phase === 'parked') {
    const a = g.parkAng0 + g.parkOm * (simTime - g.parkT0) + (s.fi - (g.count0 - 1) / 2) * 0.025;
    const vt = g.parkR * g.parkOm, tp = g.planetTarget;
    return V(tp.vel.x - vt * Math.sin(a), tp.vel.y + vt * Math.cos(a));
  }
  return { ...g.vel };
}

/* ---------------- fleet guidance (1g flip-and-burn) ---------------- */
function stepGroup(g, dt) {
  if (g.role === 'defense') {
    g.pos = { ...g.planetHome.pos };
    g.vel = { ...g.planetHome.vel };
    return;
  }
  if (g.role === 'picket') { stepPicket(g, dt); return; }
  if (aliveCount(g) === 0) { g.thrusting = false; return; }

  const tp = g.planetTarget;
  if (g.phase === 'parked') {
    // analytic two-body circular orbit around the captured target
    const a = g.parkAng0 + g.parkOm * (simTime - g.parkT0);
    const c = Math.cos(a), s = Math.sin(a), vt = g.parkR * g.parkOm;
    g.pos = V(tp.pos.x + g.parkR * c, tp.pos.y + g.parkR * s);
    g.vel = V(tp.vel.x - vt * s, tp.vel.y + vt * c);
    g.fdir = V(-s, c);
    g.thrusting = false;
    return;
  }
  // gravity-assist routing: once inbound, evaluate the target's moons.
  // Only a massive moon on the near side is worth a flyby; tiny rocks are
  // ruled out honestly.
  if (!g.assistEval && g.phase === 'decel' && dist(g.pos, tp.pos) < 1.6e9) {
    g.assistEval = true;
    const navy = SIDES[g.side].navy, cls = SIDES[g.side].cls;
    const names = tp.moons.map(m => m.name).join('/');
    const cand = tp.moons.find(m => m.mu > 1e9
      && dot(norm(sub(m.pos, tp.pos)), norm(sub(g.pos, tp.pos))) > 0.45);
    if (cand) {
      g.assistMoon = cand;
      log(`${navy} strike group shapes approach for a ${cand.name} gravity assist`, cls);
    } else if (tp.moons.some(m => m.mu > 1e9)) {
      log(`${navy} strike group holds direct approach — ${names} out of position for an assist`, cls);
    } else {
      log(`${navy} strike group rules out ${names} flyby — too little mass to matter`, cls);
    }
  }
  if (g.assistMoon && !g.assistDone) {
    const m = g.assistMoon;
    if (dist(g.pos, m.pos) < 1.5e7) {
      g.assistDone = true;
      g.phase = 'accel';
      log(`${SIDES[g.side].navy} strike group slings through ${m.name}'s gravity well — final approach to ${tp.name}`, SIDES[g.side].cls);
    } else {
      transit(g, dt, m.pos, m.vel, 5e6, null);
      pushTrail(g);
      return;
    }
  }
  transit(g, dt, tp.pos, tp.vel, STANDOFF, tp);
  pushTrail(g);
}

// 1g burn toward a (possibly moving) target with flip-and-burn logic and
// gravity feed-forward; if insertBody is given, capture into a circular
// orbit around it on arrival.
function transit(g, dt, tPos, tVel, arriveR, insertBody) {
  const grav = gravAt(g.pos);
  const rel = sub(tPos, g.pos);
  const rhat = norm(rel);
  const d = len(rel) - arriveR;
  const rv = sub(g.vel, tVel);

  // terminal: close & slow — burn onto the desired end-state velocity.
  // Orbit insertion is sticky: the circularization burn itself exceeds the
  // entry speed gate, so once committed we stay committed.
  if (g.phase === 'insert' || (d < 3e6 && len(rv) < 3500)) {
    let vdes;
    if (insertBody) {
      g.phase = 'insert';
      const rb = sub(g.pos, insertBody.pos);
      const tang = norm(V(-rb.y, rb.x));            // prograde
      vdes = add(insertBody.vel, mul(tang, Math.sqrt(insertBody.mu / len(rb))));
    } else {
      vdes = tVel;
    }
    const dv = sub(vdes, g.vel);
    if (len(dv) <= G0 * dt) {
      g.vel = vdes;
      g.thrusting = false;
      if (insertBody) {
        const rb = sub(g.pos, insertBody.pos);
        g.parkR = len(rb);
        g.parkAng0 = Math.atan2(rb.y, rb.x);
        g.parkOm = Math.sqrt(insertBody.mu / g.parkR ** 3);
        g.parkT0 = simTime;
        g.phase = 'parked';
        log(`${SIDES[g.side].navy} strike group brakes into ${insertBody.name} orbit`, SIDES[g.side].cls);
      }
    } else {
      g.vel = add(add(g.vel, mul(norm(dv), G0 * dt)), mul(grav, dt));
      g.thrusting = true;
      g.aim = norm(dv);
    }
    g.pos = add(g.pos, mul(g.vel, dt));
    return;
  }

  const vAlong = dot(rv, rhat);
  // braking authority is sapped by gravity pulling us toward the target
  const gPull = Math.max(dot(grav, rhat), 0);
  const aBrake = Math.max(G0 - gPull, 4);
  const stop = vAlong > 0 ? vAlong * vAlong / (2 * aBrake) : 0;
  const wantDecel = g.phase === 'decel'
    ? (vAlong > 0 && stop > 0.90 * d)
    : (vAlong > 0 && stop >= d);

  let thrustDir;
  if (wantDecel) {
    if (!g.flipped && g.role === 'strike') {
      g.flipped = true;
      log(`${SIDES[g.side].navy} strike group flips ship — deceleration burn for ${g.planetTarget.name}`, SIDES[g.side].cls);
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
  g.vel = add(g.vel, add(mul(thrustDir, G0 * dt), mul(grav, dt)));
  g.pos = add(g.pos, mul(g.vel, dt));
  g.thrusting = true;
  g.aim = thrustDir;
  if (len(sub(g.vel, tVel)) > 500) g.fdir = norm(sub(g.vel, tVel));
}

/* ---------------- moon pickets ---------------- */
function stepPicket(g, dt) {
  if (g.count0 === 0 || aliveCount(g) === 0) { g.thrusting = false; return; }
  const m = g.moon;
  const foe = GR[enemyOf(g.side)].strike;
  const foeAlive = foe.count0 > 0 && aliveCount(foe) > 0;

  if (g.mode === 'station') {
    g.pos = { ...m.pos };
    g.vel = { ...m.vel };
    g.thrusting = false;
    if (foeAlive && dist(foe.pos, g.planetHome.pos) < 8e8) {
      g.mode = 'sortie';
      g.phase = 'accel';
      log(`${SIDES[g.side].navy} ${m.name} picket sorties — burning to intercept`, SIDES[g.side].cls);
    }
    return;
  }
  if (g.mode === 'sortie' && !foeAlive) {
    g.mode = 'return';
    g.phase = 'accel';
    log(`${SIDES[g.side].navy} ${m.name} picket returns to station`, SIDES[g.side].cls);
  }
  if (g.mode === 'return') {
    if (dist(g.pos, m.pos) < 3e6 && len(sub(g.vel, m.vel)) < 600) {
      g.mode = 'station';
      return;
    }
    transit(g, dt, m.pos, m.vel, 0, null);
  } else {
    transit(g, dt, foe.pos, foe.vel, 1.2e7, null);
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
  const pk = a.role === 'picket' ? a : (b.role === 'picket' ? b : null);
  if (pk) return pk.moon.name.toUpperCase() + ' PICKET ENGAGEMENT';
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
  // prefer targets with a clear line of sight (planets and moons block fire)
  const allT = aliveShips(enemy);
  const vis = allT.filter(ts => losClear(g.pos, shipPos(enemy, ts)));
  const targets = vis.length ? vis : allT;
  let n = 0;
  for (const s of aliveShips(g)) {
    const k = Math.min(SALVO_SIZE, s.ammo);
    for (let i = 0; i < k; i++) {
      const tgt = targets[bt.tIdx++ % targets.length];
      const p0 = shipPos(g, s);
      const tgtP = shipPos(enemy, tgt);
      if (!losClear(p0, tgtP)) continue;   // hold fire while the planet blocks the shot
      s.ammo--;
      const aim = norm(sub(tgtP, p0));
      bt.torps.push({
        id: torpId++, side: g.side, tGroup: enemy, tShip: tgt,
        pos: p0, vel: add(shipVel(g, s), mul(aim, 200)),
        alive: true, age: 0, recede: 0, tImp: Infinity, engaged: false
      });
      n++;
    }
  }
  if (n) {
    bt.lastSalvo[g.id] = simTime;
    bt.lastTorpTime = simTime;
    stats.fired[g.side] += n;
    const who = g.role === 'defense' ? 'home fleet' : g.role === 'picket' ? `${g.moon.name} picket` : 'strike group';
    if (n >= 3 || !bt.loggedSalvo) {
      bt.loggedSalvo = true;
      log(`${SIDES[g.side].navy} ${who} launches ${n} torpedo${n > 1 ? 'es' : ''}`, SIDES[g.side].cls);
    }
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
  const tvel = shipVel(t.tGroup, t.tShip);
  const relP = sub(tpos, t.pos);
  const d = len(relP);
  const relV = sub(tvel, t.vel);
  const closing = -dot(relP, relV) / Math.max(d, 1);
  t.tImp = closing > 1 ? d / closing : Infinity;

  if (closing < 0) { t.recede += dt; if (t.recede > 30) { t.alive = false; return; } }
  else t.recede = 0;

  // proportional pursuit with lead, under planetary gravity
  const tgo = Math.min(d / Math.max(closing, 100), 900);
  const desired = sub(add(tpos, mul(tvel, tgo)), add(t.pos, mul(t.vel, tgo)));
  const grav = gravAt(t.pos);
  const acc = add(mul(norm(desired), TORP_ACC), grav);

  // integrate + closest-approach hit test within the substep
  const prev = t.pos;
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
    return;
  }
  // terrain: torpedoes splash against planets and moons
  const seg = sub(t.pos, prev);
  const den = Math.max(dot(seg, seg), 1e-9);
  for (const c of COLLIDERS) {
    const tt = clamp(dot(sub(c.pos, prev), seg) / den, 0, 1);
    const q = add(prev, mul(seg, tt));
    if (dist(q, c.pos) < c.colR) {
      t.alive = false;
      explosions.push({ pos: q, wall0: wallNow, big: false });
      break;
    }
  }
}

function killShip(g, s, atPos) {
  if (!s.alive) return;
  s.alive = false;
  stats.lost[g.side]++;
  explosions.push({ pos: atPos, wall0: wallNow, big: true });
  log(`${SIDES[g.side].navy} ${s.name} destroyed`, SIDES[g.side].cls);
  if (aliveCount(g) === 0) {
    const what = g.role === 'defense' ? `home fleet over ${g.planetHome.name}`
      : g.role === 'picket' ? `${g.moon.name} picket` : 'strike group';
    log(`${SIDES[g.side].navy} ${what} ANNIHILATED`, 'sys');
  }
}

function stepPDC(bt, dt) {
  for (const g of [bt.a, bt.b]) {
    const threats = bt.torps.filter(t => t.alive && t.tGroup === g && t.tImp < PDC_WINDOW
      && losClear(shipPos(g, t.tShip), t.pos));
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
    if (aliveCount(GR[tgtKey].home) > 0 || GR[tgtKey].pickets.some(p => aliveCount(p) > 0)) continue;
    if (battles.some(bt => !bt.done && (bt.a === g || bt.b === g))) continue;
    captured[tgtKey] = g.side;
    log(`${SIDES[tgtKey].planet.name.toUpperCase()} HAS FALLEN — ${SIDES[g.side].navy} controls its orbitals`, 'sys');
  }
}

function checkGameOver() {
  if (gameOver || !running) return;
  const resolved = attackGroups.every(g => aliveCount(g) === 0 || g.phase === 'parked');
  const quiet = battles.every(bt => bt.done);
  // a picket still burning toward a live enemy means the fight isn't over
  const pendingPicket = ['earth', 'mars'].some(k => {
    const e = GR[enemyOf(k)].strike;
    return GR[k].pickets.some(p =>
      aliveCount(p) > 0 && p.mode === 'sortie'
      && e.count0 > 0 && aliveCount(e) > 0 && groupAmmo(p) + groupAmmo(e) > 0);
  });
  if (resolved && quiet && !pendingPicket) {
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
    S.innerHTML = 'The UMSF strike force holds Earth orbit unopposed.';
  } else if (mFell) {
    T.textContent = 'EARTH VICTORIOUS'; T.className = 'earthC';
    S.innerHTML = 'The PFE strike force holds Mars orbit unopposed.';
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
    `PFE ships lost      ${stats.lost.earth} of ${N_SHIPS}\n` +
    `UMSF ships lost     ${stats.lost.mars} of ${N_SHIPS}\n` +
    `Torpedoes fired     PFE ${stats.fired.earth} · UMSF ${stats.fired.mars}\n` +
    `PDC intercepts      PFE ${stats.pdc.earth} · UMSF ${stats.pdc.mars}`;
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
  return clamp(next / 3, 60, 120000);
}

/* ===================================================================
   RENDERING — delegated to the WebGL renderer in gfx3d.js
   =================================================================== */
const canvas = document.getElementById('c');
let W = window.innerWidth, H = window.innerHeight;
const gfxReady = (typeof GFX !== 'undefined' && GFX)
  ? GFX.init(canvas, {
      SIDES,
      planets: [earth, mars],
      bodies: COLLIDERS,
      helpers: { aliveCount, aliveShips, shipPos, shipVel, fmtKm }
    })
  : false;

if (!gfxReady && typeof window !== 'undefined' && window.document && document.body)
  log('WebGL unavailable — graphics disabled, simulation still runs', 'sys');

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  if (gfxReady) GFX.resize(W, H);
}
window.addEventListener('resize', resize);
resize();

/* ---------------- battle insets ---------------- */
function activeInsets() {
  return battles.filter(bt => !bt.done || wallNow - bt.doneWall < 2.5).slice(-2);
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
const PHASE_LABEL = { accel: 'ACCEL 1g ▸', decel: 'DECEL 1g ◂', parked: 'IN ENEMY ORBIT', orbit: 'IN ORBIT' };
const PICKET_LABEL = { station: 'on station', sortie: 'SORTIE ▸', return: 'returning' };

function panelHTML(key) {
  const side = SIDES[key];
  const strike = GR[key].strike, home = GR[key].home, pickets = GR[key].pickets;
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
  for (const picket of pickets) {
    const n = aliveCount(picket);
    out += n === 0
      ? `PICKET  <span class="dim">0/${picket.count0} — DESTROYED</span>\n`
      : `PICKET  ${n}/${picket.count0} · ${picket.moon.name} ${PICKET_LABEL[picket.mode] || ''}\n`;
  }
  const ammo = groupAmmo(strike) + groupAmmo(home) + pickets.reduce((a, p) => a + groupAmmo(p), 0);
  out += `<span class="dim">TORPS   ${ammo} in tubes · ${stats.fired[key]} fired</span>`;
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

  if (gfxReady) {
    GFX.render({
      wallNow, simTime, dtWall, running,
      groups: GR ? allGroups : [],
      attackGroups: GR ? attackGroups : [],
      battles,
      insets: running ? activeInsets() : [],
      explosions
    });
  }

  if (running) {
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
    `the home fleet holds your orbitals, with a third of it picketing ` +
    `<b>${side.moons.map(m => m.name).join(' and ')}</b> to flank any attacker. Your choice stays sealed.`;
  const att = +$('allocSlider').value, def = N_SHIPS - att;
  const pk = Math.floor(def / 3);
  const col = side.color;
  let lines =
    `STRIKE FORCE &nbsp;<span class="ships" style="color:${col}">${'▲'.repeat(att) || '—'}</span>&nbsp; ${att}<br>` +
    `HOME FLEET &nbsp;&nbsp;&nbsp;<span class="ships" style="color:${col}">${'△'.repeat(def - pk) || '—'}</span>&nbsp; ${def - pk}`;
  for (const { moon, n } of picketPlan(allocPhase, pk))
    lines += `<br>${moon.name.toUpperCase()} PICKET&nbsp;&nbsp;<span class="ships" style="color:${col}">${'△'.repeat(n) || '—'}</span>&nbsp; ${n}`;
  $('allocReadout').innerHTML = lines;
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
  log('WAR DECLARED — both fleets light their torch drives', 'sys');
  for (const key of ['earth', 'mars']) {
    const s = SIDES[key];
    if (alloc[key] > 0)
      log(`${s.navy} strike group (${alloc[key]} ships) departs ${s.planet.name} — 1g burn`, s.cls);
    else
      log(`${s.navy} commits no ships to the attack — full defensive posture`, s.cls);
    if (GR[key].home.count0 > 0)
      log(`${s.navy} home fleet (${GR[key].home.count0} ships) holds ${s.planet.name} orbit`, s.cls);
    for (const p of GR[key].pickets)
      log(`${s.navy} stations ${p.count0}-ship picket at ${p.moon.name}`, s.cls);
  }
}
