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

const N_SHIPS    = 12;          // starting fleet per side
const FLEET_CAP  = 16;          // shipyard ceiling
const PROD_BASE  = 2;           // new hulls per round (zero while blockaded)
const ROUND_GAP  = 60 * 86400;  // refit time between rounds — planets keep moving
const MAX_ROUNDS = 5;
const SUPREMACY  = 2;           // attacker:defender ratio that forces a capitulation
const TORP_ACC   = 490;         // torpedo drive, ~50 g
const TORP_AMMO  = 8;           // torpedoes per ship
const SALVO_SIZE = 2;           // torpedoes per ship per salvo
const SALVO_CD   = 55;          // s between salvos
const HIT_R      = 450;         // proximity-fuse radius, m
const STANDOFF   = 2.2e7;       // strike group parks 22,000 km from planet
const PDC_WINDOW = 14;          // s-to-impact at which PDCs engage
const PDC_KPS    = 0.15;        // kill prob / s for a fully engaged torpedo
const PDC_PER_SHIP = 2;         // torpedoes a ship can fully engage at once
const PDC_PLANET_BONUS = 2;     // extra engagement capacity for home fleets

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
// belt objectives — real orbital elements (2D projection), tiny but honest masses
const ceres  = makePlanet('Ceres',  '#b8a98c', 2.766 * AU, 0.0785, 153 * RAD, -0.19, 3, 4.7e5,  6.26e10);
const pallas = makePlanet('Pallas', '#8fa3a8', 2.773 * AU, 0.2300, 310 * RAD, -1.49, 3, 2.56e5, 1.3e10);
earth.sideKey = 'earth'; mars.sideKey = 'mars';
earth.sysR = 2.7; mars.sysR = 2.3; ceres.sysR = 1.1; pallas.sysR = 1.0;
earth.rotPeriod = 86164; mars.rotPeriod = 88775; ceres.rotPeriod = 32700; pallas.rotPeriod = 28100;
const STATIONS = [
  { key: 'ceres', body: ceres },
  { key: 'pallas', body: pallas }
];
const luna   = makeMoon('Luna',   '#9aa3b8', earth, 3.844e8,  4.9048e12, 2.5, 1.7374e6, 1.85e6, 0.9);
const phobos = makeMoon('Phobos', '#8a7d72', mars,  9.376e6,  0,         1.5, 1.1e4,    2.5e4,  2.1);
const deimos = makeMoon('Deimos', '#8a7d72', mars,  2.3463e7, 0,         1.5, 6.2e3,    2e4,    4.4);

// bodies that pull on ships & torpedoes / that torpedoes can crash into
const GRAV_BODIES = [earth, mars, luna];
const COLLIDERS = [earth, mars, luna, phobos, deimos, ceres, pallas];
ceres.colR = 6e5; pallas.colR = 3.5e5;

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
            'Sentinel', 'Bastion', 'Resolute', 'Vanguard', 'Tempest', 'Horizon',
            'Aurora', 'Citadel', 'Paragon', 'Ironside', 'Equinox', 'Zenith',
            'Bulwark', 'Dauntless', 'Argus', 'Sovereign', 'Pinnacle', 'Corona']
  },
  mars: {
    key: 'mars', navy: 'UMSF', fullName: 'United Mars Space Force',
    color: '#ff6a45', planet: mars, moons: [deimos, phobos], cls: 'm',
    names: ['Olympus', 'Tharsis', 'Valles', 'Ares', 'Acidalia', 'Hellas',
            'Elysium', 'Arcadia', 'Solis', 'Argyre', 'Utopia', 'Syrtis',
            'Daedalia', 'Amazonis', 'Chryse', 'Isidis', 'Nepenthes', 'Eridania',
            'Zephyria', 'Memnonia', 'Icaria', 'Aonia', 'Thaumasia', 'Noctis']
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
let selectedShip = null;        // {side, name} — roster click opens a closeup inset

/* ---------------- campaign ---------------- */
const campaign = {
  round: 0,
  score: { earth: 0, mars: 0 },
  fleet: { earth: N_SHIPS, mars: N_SHIPS },
  roster: { earth: SIDES.earth.names.slice(0, N_SHIPS), mars: SIDES.mars.names.slice(0, N_SHIPS) },
  nameIdx: { earth: N_SHIPS, mars: N_SHIPS },
  blockaded: { earth: false, mars: false },   // chokes next round's production
  kills: { earth: 0, mars: 0 },               // cumulative enemy hulls destroyed
  control: { ceres: null, pallas: null },
  over: false, winner: null
};
function nextHullName(key) {
  const names = SIDES[key].names;
  const i = campaign.nameIdx[key]++;
  return i < names.length ? names[i] : names[i % names.length] + ' II';
}

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

// alloc: number (legacy: all to strike) or {strike, ceres, pallas}
function buildFleets(allocEarth, allocMars) {
  GR = {};
  for (const [key, allocRaw] of [['earth', allocEarth], ['mars', allocMars]]) {
    const alloc = typeof allocRaw === 'number'
      ? { strike: allocRaw, ceres: 0, pallas: 0 } : allocRaw;
    const side = SIDES[key], tgt = SIDES[enemyOf(key)].planet;
    const roster = campaign.roster[key];
    const fleetN = roster.length;
    let cursor = 0;
    const take = n => {
      n = clamp(n, 0, fleetN - cursor);   // never allocate hulls you don't have
      return roster.slice(cursor, cursor += n);
    };
    const launchFrom = (g, target) => {
      const dir = norm(sub(target.pos, side.planet.pos));
      g.pos = add(side.planet.pos, mul(dir, 2.5e7));
      g.vel = { ...side.planet.vel };
      g.fdir = dir; g.aim = dir;
    };

    const strike = makeGroup(key, 'strike', take(alloc.strike), tgt);
    launchFrom(strike, tgt);
    const tasks = {};
    for (const st of STATIONS) {
      const tf = makeGroup(key, 'task', take(alloc[st.key] || 0), st.body);
      launchFrom(tf, st.body);
      tasks[st.key] = tf;
    }
    const nDef = fleetN - cursor;
    const nPicket = Math.floor(nDef / 3);   // a third of the defenders picket the moons
    const home = makeGroup(key, 'defense', take(nDef - nPicket), side.planet);
    home.pos = { ...side.planet.pos };
    home.vel = { ...side.planet.vel };
    home.ringOm = Math.sqrt(side.planet.mu / R_DEF ** 3);
    const pickets = [];
    for (const { moon, n: np } of picketPlan(key, nPicket)) {
      if (!np) continue;
      const picket = makeGroup(key, 'picket', take(np), side.planet);
      picket.moon = moon;
      picket.mode = 'station';
      // real orbit around a massive moon; powered loiter near a tiny one
      picket.ringR = moon.mu > 1e9 ? 3.5e6 : 8e5;
      picket.ringOm = moon.mu > 1e9 ? Math.sqrt(moon.mu / picket.ringR ** 3) : 1.5e-4;
      picket.pos = { ...moon.pos };
      picket.vel = { ...moon.vel };
      pickets.push(picket);
    }
    GR[key] = { strike, home, pickets, tasks };
  }
  allGroups = [];
  attackGroups = [];      // every expeditionary group: strikes + task forces
  for (const key of ['earth', 'mars']) {
    const G = GR[key];
    allGroups.push(G.strike, G.home, ...G.pickets, ...Object.values(G.tasks));
    if (G.strike.count0) attackGroups.push(G.strike);
    for (const tf of Object.values(G.tasks)) if (tf.count0) attackGroups.push(tf);
  }
  // engagements: each strike force against the defenders of its destination,
  // and rival task forces contesting the same station
  pairCandidates = [];
  for (const key of ['earth', 'mars']) {
    const st = GR[key].strike, foe = GR[enemyOf(key)];
    if (!st.count0) continue;
    if (foe.home.count0) pairCandidates.push([st, foe.home]);
    for (const p of foe.pickets) pairCandidates.push([st, p]);
  }
  for (const st of STATIONS) {
    const a = GR.earth.tasks[st.key], b = GR.mars.tasks[st.key];
    if (a.count0 && b.count0) pairCandidates.push([a, b]);
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
  if ((g.role === 'strike' || g.role === 'task') && g.phase === 'parked') {
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
  if ((g.role === 'strike' || g.role === 'task') && g.phase === 'parked') {
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
  if (!g.assistEval && g.role === 'strike' && g.phase === 'decel' && dist(g.pos, tp.pos) < 1.6e9) {
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
  transit(g, dt, tp.pos, tp.vel, tp.mu > 1e12 ? STANDOFF : 2.5e6, tp);
  pushTrail(g);
}

const groupNoun = g => g.role === 'task' ? `${g.planetTarget.name} task force`
  : g.role === 'picket' ? `${g.moon.name} picket`
  : g.role === 'defense' ? 'home fleet' : 'strike group';

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
        log(`${SIDES[g.side].navy} ${groupNoun(g)} brakes into ${insertBody.name} orbit`, SIDES[g.side].cls);
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
    if (!g.flipped && (g.role === 'strike' || g.role === 'task')) {
      g.flipped = true;
      log(`${SIDES[g.side].navy} ${groupNoun(g)} flips ship — deceleration burn for ${g.planetTarget.name}`, SIDES[g.side].cls);
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
  if (a.role === 'task' && b.role === 'task')
    return 'BATTLE FOR ' + a.planetTarget.name.toUpperCase() + ' STATION';
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
    // a pair locked in standoff stays disengaged until someone moves on it
    let prior = null;
    for (let i = battles.length - 1; i >= 0; i--) {
      const bt = battles[i];
      if ((bt.a === a && bt.b === b) || (bt.a === b && bt.b === a)) { prior = bt; break; }
    }
    if (prior && prior.done && prior.standoff && closing < 1000) continue;
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
    if (n >= 3 || !bt.loggedSalvo) {
      bt.loggedSalvo = true;
      log(`${SIDES[g.side].navy} ${groupNoun(g)} launches ${n} torpedo${n > 1 ? 'es' : ''}`, SIDES[g.side].cls);
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
    const what = g.role === 'defense' ? `home fleet over ${g.planetHome.name}` : groupNoun(g);
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
  else if (noAmmo && simTime - bt.lastTorpTime > 120) { msg = 'magazines dry — uneasy standoff'; bt.standoff = true; }
  // e.g. two forces parked either side of an asteroid, neither able to shoot
  else if (simTime - bt.lastTorpTime > 1800) { msg = 'no firing solution — standoff'; bt.standoff = true; }
  if (msg) {
    bt.done = true;
    bt.doneWall = wallNow;
    log(`${bt.title} — ${msg}`, 'sys');
  }
}

/* ---------------- captures & endgame ---------------- */
// a homeworld falls to orbital supremacy: defenders annihilated, or the
// parked attacker outnumbers what's left of them SUPREMACY-to-one
function checkCaptures() {
  for (const g of attackGroups) {
    if (g.role !== 'strike') continue;
    if (g.phase !== 'parked' || aliveCount(g) === 0) continue;
    const tgtKey = enemyOf(g.side);
    if (captured[tgtKey]) continue;
    const defAlive = aliveCount(GR[tgtKey].home)
      + GR[tgtKey].pickets.reduce((n, p) => n + aliveCount(p), 0);
    if (defAlive > 0 && aliveCount(g) < SUPREMACY * defAlive) continue;
    if (GR[tgtKey].pickets.some(p => aliveCount(p) > 0 && p.mode === 'sortie')) continue;
    if (battles.some(bt => !bt.done && (bt.a === g || bt.b === g))) continue;
    captured[tgtKey] = g.side;
    log(`${SIDES[tgtKey].planet.name.toUpperCase()} HAS FALLEN — ${SIDES[g.side].navy} ${defAlive > 0 ? 'forces capitulation with orbital supremacy' : 'controls its orbitals'}`, 'sys');
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
    endRound();
  }
}

let roundResult = null;

function endRound() {
  const pts = { earth: 0, mars: 0 };
  const lines = [];
  const eFell = !!captured.earth, mFell = !!captured.mars;

  // station control: +1 point and +1 hull of production
  for (const st of STATIONS) {
    const holds = {};
    for (const key of ['earth', 'mars']) {
      const tf = GR[key].tasks[st.key];
      holds[key] = tf.count0 > 0 && aliveCount(tf) > 0 && tf.phase === 'parked';
    }
    const owner = holds.earth && !holds.mars ? 'earth' : holds.mars && !holds.earth ? 'mars' : null;
    campaign.control[st.key] = owner;
    if (owner) {
      pts[owner] += 1;
      lines.push({ side: owner, txt: `${SIDES[owner].navy} holds ${st.body.name} Station — +1 pt, +1 hull next round` });
      log(`${SIDES[owner].navy} secures ${st.body.name} Station`, SIDES[owner].cls);
    } else if (holds.earth && holds.mars) {
      lines.push({ side: null, txt: `${st.body.name} Station contested — nobody scores` });
    }
  }

  // blockade: enemy strike parked over a surviving homeworld
  campaign.blockaded = { earth: false, mars: false };
  for (const key of ['earth', 'mars']) {
    const foeKey = enemyOf(key);
    const foe = GR[foeKey].strike;
    if (!captured[key] && foe.count0 > 0 && aliveCount(foe) > 0 && foe.phase === 'parked') {
      campaign.blockaded[key] = true;
      pts[foeKey] += 2;
      lines.push({ side: foeKey, txt: `${SIDES[foeKey].navy} blockades ${SIDES[key].planet.name} — +2 pts, shipyards choked` });
      log(`${SIDES[foeKey].navy} blockades ${SIDES[key].planet.name} — orbital trade strangled`, 'sys');
    }
  }

  // attrition edge
  if (stats.lost.earth !== stats.lost.mars) {
    const w = stats.lost.earth < stats.lost.mars ? 'earth' : 'mars';
    pts[w] += 1;
    lines.push({ side: w, txt: `${SIDES[w].navy} wins the exchange ${stats.lost[enemyOf(w)]}\u2013${stats.lost[w]} — +1 pt` });
  }
  if (!lines.length) lines.push({ side: null, txt: 'No points scored — an uneventful round.' });

  campaign.kills.earth += stats.lost.mars;
  campaign.kills.mars += stats.lost.earth;
  campaign.score.earth += pts.earth;
  campaign.score.mars += pts.mars;

  // survivors return home; shipyards deliver new hulls
  for (const key of ['earth', 'mars']) {
    const survivors = [];
    for (const g of [GR[key].strike, ...Object.values(GR[key].tasks), GR[key].home, ...GR[key].pickets])
      for (const s of g.ships) if (s.alive) survivors.push(s.name);
    let prod = 0;
    if (!captured[key]) {
      prod = campaign.blockaded[key] ? 0 : PROD_BASE;
      for (const st of STATIONS) if (campaign.control[st.key] === key) prod += 1;
    }
    while (prod-- > 0 && survivors.length < FLEET_CAP) survivors.push(nextHullName(key));
    campaign.roster[key] = survivors;
    campaign.fleet[key] = survivors.length;
  }

  // campaign termination: conquest wins outright; otherwise play to MAX_ROUNDS
  if (eFell || mFell) {
    campaign.over = true;
    campaign.winner = eFell && mFell ? null : (eFell ? 'mars' : 'earth');
  } else if (campaign.round >= MAX_ROUNDS) {
    campaign.over = true;
  }
  if (campaign.over && !campaign.winner) {
    const c = campaign;   // tie-breaks: points, total kills, surviving hulls
    campaign.winner =
        c.score.earth !== c.score.mars ? (c.score.earth > c.score.mars ? 'earth' : 'mars')
      : c.kills.earth !== c.kills.mars ? (c.kills.earth > c.kills.mars ? 'earth' : 'mars')
      : c.fleet.earth !== c.fleet.mars ? (c.fleet.earth > c.fleet.mars ? 'earth' : 'mars')
      : null;
  }
  roundResult = { pts, lines, eFell, mFell };
  log(`— ROUND ${campaign.round} COMPLETE — ${SIDES.earth.navy} ${campaign.score.earth} · ${SIDES.mars.navy} ${campaign.score.mars}`, 'sys');
}

const LINE_COL = { earth: 'earthC', mars: 'marsC' };
function showRoundScreen() {
  if (campaign.over) { showCampaignEnd(); return; }
  const r = roundResult || { pts: { earth: 0, mars: 0 }, lines: [] };
  $('roundTitle').textContent = `ROUND ${campaign.round} of ${MAX_ROUNDS} COMPLETE`;
  $('roundSub').innerHTML = r.lines.map(l =>
    `<div class="${l.side ? LINE_COL[l.side] : ''}">${l.txt}</div>`).join('');
  $('roundStats').textContent =
    `Score               ${SIDES.earth.navy} ${campaign.score.earth} \u00b7 ${SIDES.mars.navy} ${campaign.score.mars}\n` +
    `Fleets next round   ${SIDES.earth.navy} ${campaign.fleet.earth} \u00b7 ${SIDES.mars.navy} ${campaign.fleet.mars} hulls\n` +
    `Hulls destroyed     ${SIDES.earth.navy} ${campaign.kills.earth} \u00b7 ${SIDES.mars.navy} ${campaign.kills.mars}\n` +
    `Campaign clock      T+ ${fmtTime(simTime)}`;
  showScreen('s-round');
  $('overlay').style.display = 'flex';
}

function showCampaignEnd() {
  const T = $('endTitle'), S = $('endSub');
  const w = campaign.winner;
  const r = roundResult || { eFell: false, mFell: false };
  if (r.eFell && r.mFell) {
    T.textContent = 'MUTUAL RUIN'; T.className = 'amberC';
    S.innerHTML = w
      ? `Both homeworlds burned. History gives the ${SIDES[w].fullName} the bitter edge on points.`
      : 'Both homeworlds burned. Nobody won this war.';
  } else if (r.eFell || r.mFell) {
    T.textContent = (w === 'earth' ? 'EARTH' : 'MARS') + ' VICTORIOUS — CONQUEST';
    T.className = w === 'earth' ? 'earthC' : 'marsC';
    S.innerHTML = `${SIDES[w].fullName} forces capitulation at ${SIDES[enemyOf(w)].planet.name} in round ${campaign.round}.`;
  } else if (w) {
    T.textContent = (w === 'earth' ? 'EARTH' : 'MARS') + ' WINS ON POINTS';
    T.className = w === 'earth' ? 'earthC' : 'marsC';
    S.innerHTML = `After ${campaign.round} rounds, the ${SIDES[w].fullName} holds the strategic edge.`;
  } else {
    T.textContent = 'TRUE STALEMATE'; T.className = 'amberC';
    S.innerHTML = `${campaign.round} rounds of war and nothing to show for it on either side.`;
  }
  $('endStats').textContent =
    `Final score         ${SIDES.earth.navy} ${campaign.score.earth} \u00b7 ${SIDES.mars.navy} ${campaign.score.mars}\n` +
    `Hulls destroyed     ${SIDES.earth.navy} ${campaign.kills.earth} \u00b7 ${SIDES.mars.navy} ${campaign.kills.mars}\n` +
    `Surviving fleets    ${SIDES.earth.navy} ${campaign.fleet.earth} \u00b7 ${SIDES.mars.navy} ${campaign.fleet.mars}\n` +
    `War duration        ${fmtTime(simTime)} over ${campaign.round} round${campaign.round > 1 ? 's' : ''}`;
  showScreen('s-end');
  $('overlay').style.display = 'flex';
}

/* ---------------- physics master step ---------------- */
function stepPhysics(h) {
  simTime += h;
  earth.update(simTime);
  mars.update(simTime);
  ceres.update(simTime);
  pallas.update(simTime);
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
  // paced so a typical interplanetary transit takes about a minute of wall time
  return clamp(next / 5, 50, 80000);
}

/* ===================================================================
   RENDERING — delegated to the WebGL renderer in gfx3d.js
   =================================================================== */
const canvas = document.getElementById('c');
let W = window.innerWidth, H = window.innerHeight;
const gfxReady = (typeof GFX !== 'undefined' && GFX)
  ? GFX.init(canvas, {
      SIDES,
      planets: [earth, mars, ceres, pallas],
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
// Always-on home-space views for both planets, plus tracking views that
// follow each strike force through transit, flybys and intercepts.
const MOONS_ALL = [luna, phobos, deimos];

function insetDescriptors() {
  if (!GR) return [];
  const list = [];
  for (const key of ['earth', 'mars']) {
    const planet = SIDES[key].planet;
    const foe = GR[enemyOf(key)].strike;
    let half = 4.8e7;
    let title = planet.name.toUpperCase() + ' — HOME SPACE';
    let battle = null;
    if (foe.count0 && aliveCount(foe) > 0) {
      const d = dist(foe.pos, planet.pos);
      if (d < 3.5e8) half = Math.max(half, d * 0.72);
      if (foe.phase === 'parked')
        title = planet.name.toUpperCase() + (captured[key] ? ' — OCCUPIED' : ' — ORBIT CONTESTED');
    }
    for (const bt of battles) {
      if (bt.done) continue;
      const bx = (bt.a.pos.x + bt.b.pos.x) / 2, by = (bt.a.pos.y + bt.b.pos.y) / 2;
      if (Math.hypot(bx - planet.pos.x, by - planet.pos.y) < 4e8) {
        title = bt.title;
        battle = bt;
        half = Math.max(half, dist(bt.a.pos, bt.b.pos) * 0.62);
      }
    }
    list.push({ id: key, title, cx: planet.pos.x, cy: planet.pos.y, half, col: key === 'earth' ? 0 : 1, battle });
  }
  for (const key of ['earth', 'mars']) {
    const g = GR[key].strike;
    if (!g.count0 || aliveCount(g) === 0 || g.phase === 'parked') continue;
    let half = 3.5e7;
    let title = `${SIDES[key].navy} STRIKE — ${g.phase === 'decel' ? 'DECEL' : g.phase === 'insert' ? 'ORBIT INSERTION' : 'ACCEL'} 1g`;
    let battle = null;
    if (g.assistMoon && !g.assistDone && dist(g.pos, g.assistMoon.pos) < 6e8)
      title = `${SIDES[key].navy} STRIKE — ${g.assistMoon.name.toUpperCase()} FLYBY`;
    for (const m of MOONS_ALL) {
      const d = dist(g.pos, m.pos);
      if (d < 4e8) half = Math.max(half, Math.min(d * 0.8, 4e8));
    }
    for (const bt of battles) {
      if (bt.done || (bt.a !== g && bt.b !== g)) continue;
      title = bt.title;
      battle = bt;
      half = Math.max(half, dist(bt.a.pos, bt.b.pos) * 0.62);
    }
    list.push({ id: 'strike-' + key, title, cx: g.pos.x, cy: g.pos.y, half, col: key === 'earth' ? 0 : 1, battle });
  }
  // station views whenever anyone is operating near them
  for (const st of STATIONS) {
    const a = GR.earth.tasks[st.key], b = GR.mars.tasks[st.key];
    const around = [a, b].filter(g => g.count0 && aliveCount(g) > 0 && dist(g.pos, st.body.pos) < 6e8);
    if (!around.length) continue;
    let half = 2.5e7, battle = null;
    const owner = campaign.control[st.key];
    let title = st.body.name.toUpperCase() + ' STATION' + (owner ? ` — ${SIDES[owner].navy}` : '');
    for (const g of around) half = Math.max(half, dist(g.pos, st.body.pos) * 0.8);
    for (const bt of battles) {
      if (bt.done) continue;
      if ((bt.a === a && bt.b === b) || (bt.a === b && bt.b === a)) {
        title = bt.title;
        battle = bt;
        half = Math.max(half, dist(bt.a.pos, bt.b.pos) * 0.62);
      }
    }
    list.push({
      id: st.key, title, cx: st.body.pos.x, cy: st.body.pos.y,
      half: Math.min(half, 4.5e8), col: st.key === 'ceres' ? 0 : 1, battle
    });
  }
  // ship closeup from a roster click
  if (selectedShip) {
    let found = null, fg = null;
    for (const g of allGroups) {
      if (g.side !== selectedShip.side) continue;
      const sh = g.ships.find(s => s.name === selectedShip.name && s.alive);
      if (sh) { found = sh; fg = g; break; }
    }
    if (found) {
      const p = shipPos(fg, found);
      // splice in right after the planet views so it never falls off the cap
      list.splice(2, 0, {
        id: 'ship', title: `${SIDES[fg.side].navy} ${found.name.toUpperCase()}`,
        cx: p.x, cy: p.y, half: 8e6, zoomShips: 2.4,
        col: selectedShip.side === 'earth' ? 0 : 1, battle: null
      });
    } else {
      selectedShip = null;       // ship destroyed: drop the view
    }
  }
  return list;
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
  const tasks = Object.values(GR[key].tasks);
  for (const st of STATIONS) {
    const tf = GR[key].tasks[st.key];
    if (!tf.count0) continue;
    const n = aliveCount(tf);
    out += n === 0
      ? `TASK    <span class="dim">0/${tf.count0} — DESTROYED</span>\n`
      : `TASK    ${n}/${tf.count0} · ${st.body.name} ${tf.phase === 'parked' ? 'ON STATION' : PHASE_LABEL[tf.phase] || ''}\n`;
  }
  const ammo = [strike, home, ...pickets, ...tasks].reduce((a, g) => a + groupAmmo(g), 0);
  out += `<span class="dim">TORPS   ${ammo} in tubes · ${stats.fired[key]} fired</span>`;
  // clickable ship roster — opens a closeup inset
  out += '<div class="roster">';
  for (const g of [strike, ...tasks, home, ...pickets])
    for (const s of g.ships) {
      const sel = selectedShip && selectedShip.side === key && selectedShip.name === s.name;
      out += `<span class="rost${s.alive ? '' : ' dead'}${sel ? ' sel' : ''}" data-name="${s.name}">` +
        `${s.alive ? '▲' : '✕'} ${s.name}</span>`;
    }
  out += '</div>';
  return out;
}

let hudTimer = 0;
function updateHUD(dtWall) {
  hudTimer -= dtWall;
  if (hudTimer > 0) return;
  hudTimer = 0.12;
  $('clock').textContent = 'T+ ' + fmtTime(simTime);
  $('tscale').textContent = (paused ? '— PAUSED — · ' : `TIME ${fmtScale(timeScale)} · ${autoTime ? 'AUTO' : 'MANUAL'} · `)
    + `ROUND ${campaign.round}/${MAX_ROUNDS} · ${SIDES.earth.navy} ${campaign.score.earth}–${campaign.score.mars} ${SIDES.mars.navy}`;
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
      insets: running ? insetDescriptors() : [],
      explosions
    });
  }

  if (running) {
    updateHUD(dtWall);
    if (gameOver && !endShown && wallNow - gameEndWall > 3.2) {
      endShown = true;
      showRoundScreen();
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
  else if (e.key === 'Escape') selectedShip = null;
});

/* ---------------- roster clicks ---------------- */
for (const key of ['earth', 'mars']) {
  const panel = $(key === 'earth' ? 'panelL' : 'panelR');
  if (panel && typeof panel.addEventListener === 'function') {
    panel.addEventListener('click', e => {
      const r = e.target.closest && e.target.closest('.rost');
      if (!r || r.classList.contains('dead')) return;
      const name = r.dataset.name;
      selectedShip = (selectedShip && selectedShip.side === key && selectedShip.name === name)
        ? null : { side: key, name };
      hudTimer = 0;   // refresh selection highlight immediately
    });
  }
}

/* ---------------- setup flow & campaign rounds ---------------- */
let allocPhase = 'earth';
const alloc = { earth: null, mars: null };
let curAlloc = { strike: 0, ceres: 0, pallas: 0 };

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

function fmtDur(t) {
  const d = Math.floor(t / 86400), h = Math.round((t % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function refreshAllocScreen() {
  const side = SIDES[allocPhase];
  const fleetN = campaign.fleet[allocPhase];
  const used = curAlloc.strike + curAlloc.ceres + curAlloc.pallas;
  $('allocTitle').textContent = `${side.navy} COMMAND — ROUND ${campaign.round + 1} of ${MAX_ROUNDS}`;
  $('allocTitle').className = allocPhase === 'earth' ? 'earthC' : 'marsC';
  $('allocSub').innerHTML =
    `Score ${SIDES.earth.navy} <b>${campaign.score.earth}</b> · <b>${campaign.score.mars}</b> ${SIDES.mars.navy}` +
    ` &nbsp;—&nbsp; you have <b>${fleetN} warships</b>.<br>` +
    `Capture the enemy homeworld (2:1 orbital supremacy) to win the war outright. ` +
    `Blockades +2 pts and choke enemy shipyards; stations +1 pt and +1 hull; winning the exchange +1 pt. ` +
    `Whatever you keep home defends (a third pickets <b>${side.moons.map(m => m.name).join(' & ')}</b>).`;
  const dests = [
    { k: 'strike', label: 'STRIKE → ' + SIDES[enemyOf(allocPhase)].planet.name.toUpperCase(), body: SIDES[enemyOf(allocPhase)].planet },
    { k: 'ceres', label: 'TASK FORCE → CERES', body: ceres },
    { k: 'pallas', label: 'TASK FORCE → PALLAS', body: pallas }
  ];
  let rows = '';
  for (const dd of dests) {
    const d = dist(side.planet.pos, dd.body.pos);
    const owner = campaign.control[dd.k];
    const tag = dd.k !== 'strike' && owner ? ` · held by ${SIDES[owner].navy}` : '';
    rows += `<div class="arow"><span class="adest">${dd.label}</span>` +
      `<span class="adist">${(d / AU).toFixed(2)} AU · ~${fmtDur(2 * Math.sqrt(d / G0))}${tag}</span>` +
      `<span class="actl"><span class="abtn" data-k="${dd.k}" data-d="-1">−</span>` +
      `<b class="acount" style="color:${side.color}">${curAlloc[dd.k]}</b>` +
      `<span class="abtn" data-k="${dd.k}" data-d="1">+</span></span></div>`;
  }
  $('allocRows').innerHTML = rows;
  const def = fleetN - used;
  const pk = Math.floor(def / 3);
  const col = side.color;
  let lines =
    `HOME FLEET &nbsp;&nbsp;&nbsp;<span class="ships" style="color:${col}">${'△'.repeat(def - pk) || '—'}</span>&nbsp; ${def - pk}`;
  for (const { moon, n } of picketPlan(allocPhase, pk))
    lines += `<br>${moon.name.toUpperCase()} PICKET&nbsp;&nbsp;<span class="ships" style="color:${col}">${'△'.repeat(n) || '—'}</span>&nbsp; ${n}`;
  $('allocReadout').innerHTML = lines;
}

// refit at the yards while the planets move on — advanced when the next
// round is being PLANNED so the allocation screen shows true distances
let epochFor = 0;
function advanceEpoch() {
  const target = campaign.round + 1;
  if (target === 1 || epochFor === target) return;
  epochFor = target;
  simTime += ROUND_GAP;
  earth.update(simTime); mars.update(simTime);
  ceres.update(simTime); pallas.update(simTime);
}

function beginAllocation() {
  advanceEpoch();
  allocPhase = 'earth';
  curAlloc = { strike: Math.min(6, Math.floor(campaign.fleet.earth / 2)), ceres: 0, pallas: 0 };
  refreshAllocScreen();
  showScreen('s-alloc');
  $('overlay').style.display = 'flex';
}

$('btnBegin').onclick = beginAllocation;
{
  const rowsEl = $('allocRows');
  if (rowsEl && typeof rowsEl.addEventListener === 'function') {
    rowsEl.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('.abtn');
      if (!b) return;
      const k = b.dataset.k, d = +b.dataset.d;
      const used = curAlloc.strike + curAlloc.ceres + curAlloc.pallas;
      if (d > 0 && used >= campaign.fleet[allocPhase]) return;
      curAlloc[k] = clamp(curAlloc[k] + d, 0, campaign.fleet[allocPhase]);
      refreshAllocScreen();
    });
  }
}
$('btnCommit').onclick = () => {
  alloc[allocPhase] = { ...curAlloc };
  if (allocPhase === 'earth') {
    allocPhase = 'mars';
    curAlloc = { strike: Math.min(6, Math.floor(campaign.fleet.mars / 2)), ceres: 0, pallas: 0 };
    showScreen('s-handoff');
  } else {
    $('overlay').style.display = 'none';
    $('hud').hidden = false;
    if (campaign.round === 0) log('WAR DECLARED — both fleets light their torch drives', 'sys');
    startRound(alloc.earth, alloc.mars);
  }
};
$('btnHandoff').onclick = () => { refreshAllocScreen(); showScreen('s-alloc'); };
$('btnRound').onclick = beginAllocation;
$('btnAgain').onclick = () => location.reload();

function startRound(allocE, allocM) {
  advanceEpoch();
  campaign.round++;
  battles = [];
  explosions = [];
  captured = { earth: null, mars: null };
  stats = { fired: { earth: 0, mars: 0 }, pdc: { earth: 0, mars: 0 }, lost: { earth: 0, mars: 0 } };
  selectedShip = null;
  roundResult = null;
  gameOver = false; endShown = false;
  paused = false; autoTime = true; timeScale = 1;
  buildFleets(allocE, allocM);
  running = true;
  log(`— ROUND ${campaign.round} of ${MAX_ROUNDS} —`, 'sys');
  for (const key of ['earth', 'mars']) {
    const s = SIDES[key], G = GR[key];
    if (G.strike.count0)
      log(`${s.navy} strike group (${G.strike.count0} ships) burns for ${SIDES[enemyOf(key)].planet.name}`, s.cls);
    for (const st of STATIONS)
      if (G.tasks[st.key].count0)
        log(`${s.navy} task force (${G.tasks[st.key].count0} ships) burns for ${st.body.name} Station`, s.cls);
    if (G.home.count0)
      log(`${s.navy} home fleet (${G.home.count0} ships) holds ${s.planet.name} orbit`, s.cls);
    for (const pkt of G.pickets)
      log(`${s.navy} stations ${pkt.count0}-ship picket at ${pkt.moon.name}`, s.cls);
  }
}
