'use strict';
/* =====================================================================
   gfx3d.js — WebGL renderer (three.js) for 1G.
   System view: 1 unit = 1e9 m (oblique camera, drag to orbit).
   Battle insets: 1 unit = 1e6 m, rendered as scissored viewports with
   their own scenes, lighting and slowly drifting cameras.
   ===================================================================== */
window.GFX = (function () {
  const SYS = 1e9, BTL = 1e6, TAU = Math.PI * 2;
  let renderer = null, env = null, ready = false;
  let W = 1280, H = 720;
  let sys = null;                 // system-view bundle
  const insetViews = [];          // pooled InsetView (max 2)
  let labelLayer = null;
  const labels = new Map();       // key -> {el, used}

  /* ---------------- tiny helpers ---------------- */
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* ---------------- procedural textures ---------------- */
  function glowTex(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
    const c = makeCanvas(64, 64), x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.55)'));
    g.addColorStop(1, outer);
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }
  function dotTex() {
    const c = makeCanvas(32, 32), x = c.getContext('2d');
    const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }
  function blob(x, r, cx, cy, rx, ry, rot, color, alpha) {
    x.save();
    x.translate(cx, cy); x.rotate(rot);
    x.globalAlpha = alpha;
    x.fillStyle = color;
    x.beginPath(); x.ellipse(0, 0, rx, ry, 0, 0, TAU); x.fill();
    x.restore();
  }
  function planetTex(kind) {
    const c = makeCanvas(512, 256), x = c.getContext('2d');
    const R = mulberry(kind === 'earth' ? 71 : kind === 'mars' ? 12 : kind === 'moon' ? 5 : 99);
    if (kind === 'earth') {
      const g = x.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#9bb7d8'); g.addColorStop(0.18, '#1d54a8');
      g.addColorStop(0.5, '#1b62c4'); g.addColorStop(0.82, '#1d54a8');
      g.addColorStop(1, '#9bb7d8');
      x.fillStyle = g; x.fillRect(0, 0, 512, 256);
      for (let i = 0; i < 38; i++)
        blob(x, R, R() * 512, 40 + R() * 176, 18 + R() * 58, 9 + R() * 26, R() * 3,
          ['#3a6e35', '#577d3a', '#7b7f46', '#4c6b30'][i & 3], 0.95);
      for (let i = 0; i < 46; i++)
        blob(x, R, R() * 512, R() * 256, 22 + R() * 60, 5 + R() * 14, R() * 3, '#ffffff', 0.16);
      x.fillStyle = 'rgba(240,248,255,0.95)';
      x.fillRect(0, 0, 512, 14); x.fillRect(0, 242, 512, 14);
    } else if (kind === 'mars') {
      const g = x.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#c4805a'); g.addColorStop(0.5, '#b54f28');
      g.addColorStop(1, '#c4805a');
      x.fillStyle = g; x.fillRect(0, 0, 512, 256);
      for (let i = 0; i < 42; i++)
        blob(x, R, R() * 512, R() * 256, 16 + R() * 64, 8 + R() * 24, R() * 3,
          ['#8a3a20', '#d9794a', '#6e2d18', '#c9682f'][i & 3], 0.5);
      x.fillStyle = 'rgba(245,240,235,0.9)';
      x.fillRect(0, 0, 512, 8); x.fillRect(0, 250, 512, 6);
    } else { // moon / rock
      x.fillStyle = kind === 'moon' ? '#8d9099' : '#7d7268';
      x.fillRect(0, 0, 512, 256);
      for (let i = 0; i < 70; i++) {
        const cx = R() * 512, cy = R() * 256, r = 2 + R() * 14;
        x.globalAlpha = 0.5;
        x.fillStyle = R() < 0.5 ? '#6f7178' : '#a3a6ad';
        x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
        x.globalAlpha = 0.35; x.fillStyle = '#52555c';
        x.beginPath(); x.arc(cx + r * 0.2, cy + r * 0.2, r * 0.6, 0, TAU); x.fill();
      }
      x.globalAlpha = 1;
    }
    return new THREE.CanvasTexture(c);
  }

  /* ---------------- ship asset ---------------- */
  function buildShip(color) {
    const grp = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({
      color, emissive: new THREE.Color(color).multiplyScalar(0.28)
    });
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.44, 2.0, 8), mat);
    hull.geometry.rotateX(Math.PI / 2);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.31, 0.9, 8), mat);
    nose.geometry.rotateX(Math.PI / 2);
    nose.position.z = 1.45;
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.26, 0.5, 8), mat);
    noz.geometry.rotateX(Math.PI / 2);
    noz.position.z = -1.2;
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(0.30, 2.6, 8),
      new THREE.MeshBasicMaterial({
        color: 0xaadcff, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
    plume.geometry.rotateX(Math.PI / 2);
    plume.position.z = -2.6;
    grp.add(hull, nose, noz, plume);
    grp.userData.plume = plume;
    grp.userData.mat = mat;
    return grp;
  }
  /* ---------------- explosion sprite pool ---------------- */
  function makeSpritePool(scene, tex, n) {
    const pool = [];
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, color: 0xffd9a0
      }));
      sp.visible = false;
      scene.add(sp);
      pool.push(sp);
    }
    return pool;
  }
  function showExplosions(pool, exlist, wallNow, toLocal, scaleFn, maxDist) {
    let i = 0;
    for (const ex of exlist) {
      if (i >= pool.length) break;
      const age = wallNow - ex.wall0;
      if (age > 1.1) continue;
      const p = toLocal(ex.pos);
      if (maxDist && p.length() > maxDist) continue;
      const sp = pool[i++];
      sp.visible = true;
      sp.position.copy(p);
      const s = scaleFn(age, ex.big);
      sp.scale.set(s, s, 1);
      sp.material.opacity = Math.max(1 - age, 0) * 0.95;
    }
    for (; i < pool.length; i++) pool[i].visible = false;
  }

  /* ---------------- DOM labels & inset chrome ---------------- */
  function label(key, x, y, text, color, size) {
    let L = labels.get(key);
    if (!L) {
      const el = document.createElement('div');
      el.className = 'lbl';
      labelLayer.appendChild(el);
      L = { el }; labels.set(key, L);
    }
    L.used = true;
    L.el.style.display = 'block';
    L.el.style.left = x + 'px';
    L.el.style.top = y + 'px';
    L.el.style.color = color;
    L.el.style.fontSize = (size || 10) + 'px';
    if (L.el.textContent !== text) L.el.textContent = text;
  }
  function labelsBegin() { for (const L of labels.values()) L.used = false; }
  function labelsEnd() { for (const L of labels.values()) if (!L.used) L.el.style.display = 'none'; }

  function makeChrome() {
    const root = document.createElement('div');
    root.className = 'ichrome';
    root.innerHTML = '<div class="it"></div><div class="iw"></div><div class="ila"></div><div class="ilb"></div>';
    labelLayer.appendChild(root);
    return {
      root,
      title: root.children[0], range: root.children[1],
      la: root.children[2], lb: root.children[3]
    };
  }

  /* ---------------- system view ---------------- */
  function buildSystem() {
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x202b3d, 1.0));
    const sunlight = new THREE.PointLight(0xffeecc, 1.6, 0);
    scene.add(sunlight);

    // stars
    {
      const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      const R = mulberry(42);
      for (let i = 0; i < n; i++) {
        const th = R() * TAU, ph = Math.acos(2 * R() - 1), r = 2600 + R() * 1500;
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph);
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        const b = 0.4 + R() * 0.6, t = R();
        col[i * 3] = b * (t < 0.2 ? 0.8 : 1);
        col[i * 3 + 1] = b * 0.95;
        col[i * 3 + 2] = b * (t > 0.8 ? 0.85 : 1.05);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({
        size: 1.6, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: 0.85, depthWrite: false
      })));
    }

    // sun
    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex('rgba(255,225,160,1)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffd9a0
    }));
    sunGlow.scale.set(85, 85, 1);
    scene.add(sunGlow);
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff2cc })));

    // orbit ellipses
    for (const p of env.planets) {
      const pts = [];
      for (let i = 0; i <= 256; i++) {
        const E = i / 256 * TAU;
        const xp = p.a * (Math.cos(E) - p.ecc), yp = p.b * Math.sin(E);
        const cw = Math.cos(p.varpi), sw = Math.sin(p.varpi);
        pts.push(new THREE.Vector3((xp * cw - yp * sw) / SYS, 0, (xp * sw + yp * cw) / SYS));
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0x5f7ec2, transparent: true, opacity: 0.22
      })));
    }

    // planets + defense rings
    const planetMeshes = new Map(), defRings = new Map(), planetGlows = new Map();
    for (const p of env.planets) {
      const kind = p.name === 'Earth' ? 'earth' : 'mars';
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(p.name === 'Earth' ? 2.7 : 2.3, 32, 20),
        new THREE.MeshLambertMaterial({ map: planetTex(kind), emissive: 0x10141c }));
      scene.add(mesh);
      planetMeshes.set(p.name, mesh);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex('rgba(255,255,255,1)'), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, color: p.color, opacity: 0.4
      }));
      glow.scale.setScalar(11);
      scene.add(glow);
      planetGlows.set(p.name, glow);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(4.0, 4.18, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.35,
          side: THREE.DoubleSide, depthWrite: false
        }));
      ring.geometry.rotateX(-Math.PI / 2);
      scene.add(ring);
      defRings.set(p.name, ring);
    }

    // fleet markers & trails (created lazily per group id)
    const fleets = new Map(), trails = new Map();

    // battle reticles
    const reticles = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.RingGeometry(1, 1.07, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffd27f, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
        }));
      r.geometry.rotateX(-Math.PI / 2);
      r.visible = false;
      scene.add(r);
      reticles.push(r);
    }

    const explosionPool = makeSpritePool(scene, glowTex('rgba(255,225,170,1)'), 10);

    const cam = new THREE.PerspectiveCamera(45, W / H, 0.5, 12000);
    const camState = { azim: -1.15, elev: 0.62, dist: 760 };

    return { scene, cam, camState, sunGlow, planetMeshes, planetGlows, defRings, fleets, trails, reticles, explosionPool };
  }

  function sysFleet(g) {
    let f = sys.fleets.get(g.id);
    if (!f) {
      f = buildShip(env.SIDES[g.side].color);
      f.scale.setScalar(2.4);
      sys.scene.add(f);
      sys.fleets.set(g.id, f);
    }
    return f;
  }
  function sysTrail(g) {
    let t = sys.trails.get(g.id);
    if (!t) {
      const cap = 1300;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      line.frustumCulled = false;
      sys.scene.add(line);
      t = { line, cap }; sys.trails.set(g.id, t);
    }
    return t;
  }

  function project(p3, cam, vx, vy, vw, vh) {
    const v = p3.clone().project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: vx + (v.x * 0.5 + 0.5) * vw, y: vy + (1 - (v.y * 0.5 + 0.5)) * vh };
  }

  function renderSystem(view) {
    const S = sys;
    // camera from input state
    const cs = S.camState;
    S.cam.position.set(
      Math.cos(cs.azim) * Math.cos(cs.elev) * cs.dist,
      Math.sin(cs.elev) * cs.dist,
      Math.sin(cs.azim) * Math.cos(cs.elev) * cs.dist);
    S.cam.lookAt(0, 0, 0);
    S.cam.aspect = W / H;
    S.cam.updateProjectionMatrix();
    S.cam.updateMatrixWorld();
    S.cam.matrixWorldInverse.copy(S.cam.matrixWorld).invert();

    S.sunGlow.scale.setScalar(82 + 5 * Math.sin(view.wallNow * 1.3));

    for (const p of env.planets) {
      const m = S.planetMeshes.get(p.name);
      m.position.set(p.pos.x / SYS, 0, p.pos.y / SYS);
      m.rotation.y = view.simTime / (p.name === 'Earth' ? 86164 : 88775) * TAU;
      S.planetGlows.get(p.name).position.copy(m.position);
      const ring = S.defRings.get(p.name);
      ring.position.copy(m.position);
      const sideKey = p.name === 'Earth' ? 'earth' : 'mars';
      const home = view.groups.find(g => g.side === sideKey && g.role === 'defense');
      const n = home ? env.helpers.aliveCount(home) : 0;
      ring.visible = !!home && home.count0 > 0;
      ring.material.color.set(n > 0 ? env.SIDES[sideKey].color : 0x5a6a85);
      ring.material.opacity = n > 0 ? 0.4 : 0.15;
      const sp = project(m.position, S.cam, 0, 0, W, H);
      if (sp) {
        label('pl-' + p.name, sp.x, sp.y - 22, p.name.toUpperCase(), 'rgba(200,220,255,0.8)', 10);
        if (home && home.count0 > 0)
          label('home-' + p.name, sp.x, sp.y + 22,
            n > 0 ? `HOME ${n}` : 'HOME ✕',
            n > 0 ? env.SIDES[sideKey].color : '#5a6a85', 9);
      }
    }

    // strike fleets + trails
    for (const g of view.attackGroups) {
      const alive = env.helpers.aliveCount(g) > 0;
      const f = sysFleet(g);
      f.visible = alive;
      if (alive) {
        f.position.set(g.pos.x / SYS, 0, g.pos.y / SYS);
        const d = new THREE.Vector3(g.aim.x, 0, g.aim.y).normalize();
        f.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
        const pl = f.userData.plume;
        pl.visible = g.thrusting;
        if (g.thrusting) pl.scale.set(1, 1, 0.7 + Math.random() * 0.6);
        const sp = project(f.position, S.cam, 0, 0, W, H);
        if (sp) label('fl-' + g.id, sp.x, sp.y - 16,
          `${env.SIDES[g.side].navy} ${env.helpers.aliveCount(g)}`,
          env.SIDES[g.side].color, 9);
      }
      // trail
      const tr = sysTrail(g);
      const pts = g.trail, n = Math.min(pts.length + 1, tr.cap);
      const pa = tr.line.geometry.attributes.position.array;
      const ca = tr.line.geometry.attributes.color.array;
      const col = new THREE.Color(env.SIDES[g.side].color);
      for (let i = 0; i < n; i++) {
        const p = i < pts.length ? pts[i] : g.pos;
        pa[i * 3] = p.x / SYS; pa[i * 3 + 1] = 0; pa[i * 3 + 2] = p.y / SYS;
        const f2 = Math.pow(i / Math.max(n - 1, 1), 1.6) * 0.8 + 0.04;
        ca[i * 3] = col.r * f2; ca[i * 3 + 1] = col.g * f2; ca[i * 3 + 2] = col.b * f2;
      }
      tr.line.geometry.setDrawRange(0, n);
      tr.line.geometry.attributes.position.needsUpdate = true;
      tr.line.geometry.attributes.color.needsUpdate = true;
    }

    // battle reticles
    let ri = 0;
    for (const bt of view.battles) {
      if (bt.done || ri >= S.reticles.length) continue;
      const r = S.reticles[ri++];
      r.visible = true;
      r.position.set((bt.a.pos.x + bt.b.pos.x) / 2 / SYS, 0, (bt.a.pos.y + bt.b.pos.y) / 2 / SYS);
      r.scale.setScalar(9 + 2.4 * Math.sin(view.wallNow * 5));
      r.material.opacity = 0.4 + 0.2 * Math.sin(view.wallNow * 5);
    }
    for (; ri < S.reticles.length; ri++) S.reticles[ri].visible = false;

    showExplosions(S.explosionPool, view.explosions, view.wallNow,
      p => new THREE.Vector3(p.x / SYS, 0, p.y / SYS),
      (age, big) => (1 + age * (big ? 14 : 7)), 0);

    renderer.setViewport(0, 0, W, H);
    renderer.render(S.scene, S.cam);
  }

  /* ---------------- battle inset views ---------------- */
  function makeInsetView(idx) {
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x26303f, 1.0));
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.25);
    scene.add(sun);

    const grid = new THREE.PolarGridHelper(1, 12, 5, 64, 0x33558a, 0x223355);
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    scene.add(grid);

    // celestial bodies (real scale)
    const bodies = new Map();
    for (const b of env.bodies) {
      const kind = b.name === 'Earth' ? 'earth' : b.name === 'Mars' ? 'mars'
        : b.name === 'Luna' ? 'moon' : 'rock';
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24),
        new THREE.MeshLambertMaterial({ map: planetTex(kind), emissive: 0x0c1016 }));
      mesh.visible = false;
      scene.add(mesh);
      let rim = null;
      if (kind === 'earth' || kind === 'mars') {
        rim = new THREE.Mesh(new THREE.SphereGeometry(1.045, 40, 24),
          new THREE.MeshBasicMaterial({
            color: kind === 'earth' ? 0x6fb6ff : 0xff8a5a,
            transparent: true, opacity: kind === 'earth' ? 0.16 : 0.08,
            side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
          }));
        rim.visible = false;
        scene.add(rim);
      }
      bodies.set(b.name, { mesh, rim, body: b });
    }

    // ship pool
    const ships = [];
    // torpedoes: points + trails
    const TCAP = 400;
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TCAP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    tGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TCAP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const torps = new THREE.Points(tGeo, new THREE.PointsMaterial({
      size: 6, sizeAttenuation: false, map: dotTex(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    torps.frustumCulled = false;
    scene.add(torps);
    const trGeo = new THREE.BufferGeometry();
    trGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TCAP * 6), 3).setUsage(THREE.DynamicDrawUsage));
    trGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TCAP * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const torpTrails = new THREE.LineSegments(trGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    torpTrails.frustumCulled = false;
    scene.add(torpTrails);

    // PDC tracers
    const RCAP = 240;
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RCAP * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const tracers = new THREE.LineSegments(rGeo, new THREE.LineBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    tracers.frustumCulled = false;
    scene.add(tracers);

    const explosionPool = makeSpritePool(scene, glowTex('rgba(255,225,170,1)'), 12);
    const cam = new THREE.PerspectiveCamera(48, 1, 0.005, 60000);
    const chrome = makeChrome();
    return { idx, scene, cam, sun, grid, bodies, ships, torps, torpTrails, tracers, explosionPool, chrome };
  }

  function insetShip(iv, i, color) {
    let s = iv.ships[i];
    if (!s) {
      s = buildShip(color);
      iv.scene.add(s);
      iv.ships[i] = s;
    }
    s.userData.mat.color.set(color);
    s.userData.mat.emissive.set(color).multiplyScalar(0.28);
    s.visible = true;
    return s;
  }

  function renderInset(iv, bt, rect, view) {
    const H_ = env.helpers;
    const cx = (bt.a.pos.x + bt.b.pos.x) / 2, cy = (bt.a.pos.y + bt.b.pos.y) / 2;
    const sep = Math.hypot(bt.a.pos.x - bt.b.pos.x, bt.a.pos.y - bt.b.pos.y);
    const targetHalf = Math.max(sep * 0.62, 3.2e7);
    bt.half = bt.half == null ? targetHalf
      : bt.half + (targetHalf - bt.half) * (1 - Math.exp(-1.8 * view.dtWall));
    const halfU = bt.half / BTL;
    const toL = p => new THREE.Vector3((p.x - cx) / BTL, 0, (p.y - cy) / BTL);

    // camera: slow cinematic drift
    const az = view.wallNow * 0.07 + iv.idx * 2.4, el = 0.46;
    const dist = halfU / Math.tan(iv.cam.fov / 2 * Math.PI / 180) * 1.18;
    iv.cam.position.set(Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.sin(az) * Math.cos(el) * dist);
    iv.cam.aspect = 1;
    iv.cam.lookAt(0, 0, 0);
    iv.cam.updateProjectionMatrix();
    iv.cam.updateMatrixWorld();
    iv.cam.matrixWorldInverse.copy(iv.cam.matrixWorld).invert();

    // sunlight from the real sun direction
    iv.sun.position.set(-cx, 0, -cy).normalize().multiplyScalar(100);
    iv.grid.scale.setScalar(halfU);

    // bodies
    for (const { mesh, rim, body } of iv.bodies.values()) {
      const lp = toL(body.pos);
      const vis = lp.length() < halfU * 2.4;
      mesh.visible = vis;
      if (rim) rim.visible = vis;
      if (!vis) continue;
      const r = Math.max(body.realR / BTL, halfU * 0.012);
      mesh.position.copy(lp);
      mesh.scale.setScalar(r);
      mesh.rotation.y = view.simTime / 1e5;
      if (rim) { rim.position.copy(lp); rim.scale.setScalar(r); }
      const sp = project(lp, iv.cam, rect.x, rect.y, rect.s, rect.s);
      if (sp && body.parent)
        label('iv' + iv.idx + '-' + body.name, sp.x, sp.y - r / halfU * rect.s * 0.55 - 8,
          body.name.toUpperCase(), 'rgba(170,190,220,0.7)', 8);
    }

    // ships
    const shipScale = halfU * 0.045;
    let si = 0;
    for (const g of [bt.a, bt.b]) {
      const other = g === bt.a ? bt.b : bt.a;
      const color = env.SIDES[g.side].color;
      let dir;
      if (g.role === 'defense') dir = null; // face the enemy, per ship
      else dir = new THREE.Vector3(g.aim.x, 0, g.aim.y).normalize();
      for (const sh of H_.aliveShips(g)) {
        const m = insetShip(iv, si++, color);
        m.position.copy(toL(H_.shipPos(g, sh)));
        let d = dir;
        if (!d) {
          d = new THREE.Vector3(other.pos.x - g.pos.x, 0, other.pos.y - g.pos.y).normalize();
        }
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
        m.scale.setScalar(shipScale);
        const pl = m.userData.plume;
        pl.visible = g.role !== 'defense' && g.thrusting;
        if (pl.visible) pl.scale.set(1, 1, 0.7 + Math.random() * 0.6);
      }
    }
    for (; si < iv.ships.length; si++) if (iv.ships[si]) iv.ships[si].visible = false;

    // torpedoes + trails
    const pa = iv.torps.geometry.attributes.position.array;
    const ca = iv.torps.geometry.attributes.color.array;
    const tpa = iv.torpTrails.geometry.attributes.position.array;
    const tca = iv.torpTrails.geometry.attributes.color.array;
    const fvx = (bt.a.vel.x + bt.b.vel.x) / 2, fvy = (bt.a.vel.y + bt.b.vel.y) / 2;
    let ti = 0;
    for (const t of bt.torps) {
      if (!t.alive || ti >= 400) continue;
      const lp = toL(t.pos);
      pa[ti * 3] = lp.x; pa[ti * 3 + 1] = 0; pa[ti * 3 + 2] = lp.z;
      const col = new THREE.Color(t.side === 'earth' ? 0xbfe0ff : 0xffc4a8);
      ca[ti * 3] = col.r; ca[ti * 3 + 1] = col.g; ca[ti * 3 + 2] = col.b;
      // trail: short streak against the battle frame velocity
      const rvx = t.vel.x - fvx, rvy = t.vel.y - fvy;
      const rl = Math.hypot(rvx, rvy) || 1;
      const trailLen = halfU * 0.05;
      tpa[ti * 6] = lp.x; tpa[ti * 6 + 1] = 0; tpa[ti * 6 + 2] = lp.z;
      tpa[ti * 6 + 3] = lp.x - rvx / rl * trailLen;
      tpa[ti * 6 + 4] = 0;
      tpa[ti * 6 + 5] = lp.z - rvy / rl * trailLen;
      tca[ti * 6] = col.r; tca[ti * 6 + 1] = col.g; tca[ti * 6 + 2] = col.b;
      tca[ti * 6 + 3] = 0; tca[ti * 6 + 4] = 0; tca[ti * 6 + 5] = 0;
      ti++;
    }
    iv.torps.geometry.setDrawRange(0, ti);
    iv.torps.geometry.attributes.position.needsUpdate = true;
    iv.torps.geometry.attributes.color.needsUpdate = true;
    iv.torpTrails.geometry.setDrawRange(0, ti * 2);
    iv.torpTrails.geometry.attributes.position.needsUpdate = true;
    iv.torpTrails.geometry.attributes.color.needsUpdate = true;

    // PDC tracers
    const ra = iv.tracers.geometry.attributes.position.array;
    let rj = 0;
    for (const t of bt.torps) {
      if (!t.alive || !t.engaged || rj >= 240) continue;
      const defenders = env.helpers.aliveShips(t.tGroup);
      if (!defenders.length) continue;
      const src = defenders[(t.id * 7 + Math.floor(view.wallNow * 9)) % defenders.length];
      const a = toL(H_.shipPos(t.tGroup, src)), b = toL(t.pos);
      const j = halfU * 0.01;
      ra[rj * 6] = a.x; ra[rj * 6 + 1] = 0; ra[rj * 6 + 2] = a.z;
      ra[rj * 6 + 3] = b.x + (Math.random() - 0.5) * j;
      ra[rj * 6 + 4] = (Math.random() - 0.5) * j * 0.4;
      ra[rj * 6 + 5] = b.z + (Math.random() - 0.5) * j;
      rj++;
    }
    iv.tracers.geometry.setDrawRange(0, rj * 2);
    iv.tracers.geometry.attributes.position.needsUpdate = true;
    iv.tracers.material.opacity = 0.25 + Math.random() * 0.3;

    showExplosions(iv.explosionPool, view.explosions, view.wallNow,
      p => toL(p), (age, big) => (0.4 + age * (big ? 9 : 4)) * halfU * 0.06, halfU * 2.5);

    // chrome
    const c = iv.chrome;
    c.root.style.display = 'block';
    c.root.style.left = rect.x + 'px';
    c.root.style.top = rect.y + 'px';
    c.root.style.width = rect.s + 'px';
    c.root.style.height = rect.s + 'px';
    c.title.textContent = bt.title;
    c.range.textContent = '⌀ ' + env.helpers.fmtKm(bt.half * 2);
    c.la.textContent = `${env.SIDES[bt.a.side].navy} ${H_.aliveCount(bt.a)}`;
    c.la.style.color = env.SIDES[bt.a.side].color;
    c.lb.textContent = `${H_.aliveCount(bt.b)} ${env.SIDES[bt.b.side].navy}`;
    c.lb.style.color = env.SIDES[bt.b.side].color;

    // render in scissored viewport (GL origin is bottom-left)
    const vy = H - rect.y - rect.s;
    renderer.setScissorTest(true);
    renderer.setScissor(rect.x, vy, rect.s, rect.s);
    renderer.setViewport(rect.x, vy, rect.s, rect.s);
    renderer.setClearColor(0x05080f, 1);
    renderer.clear(true, true, false);
    renderer.render(iv.scene, iv.cam);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x04060d, 1);
  }

  /* ---------------- input: orbit + zoom ---------------- */
  function bindInput(canvas) {
    let drag = null;
    canvas.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const cs = sys.camState;
      cs.azim += (e.clientX - drag.x) * 0.005;
      cs.elev = Math.min(Math.max(cs.elev + (e.clientY - drag.y) * 0.004, 0.12), 1.45);
      drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const cs = sys.camState;
      cs.dist = Math.min(Math.max(cs.dist * Math.exp(e.deltaY * 0.001), 140), 2400);
    }, { passive: false });
  }

  /* ---------------- public API ---------------- */
  function init(canvas, environment) {
    if (typeof THREE === 'undefined') return false;
    env = environment;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch (e) {
      return false;
    }
    renderer.autoClear = false;
    renderer.setClearColor(0x04060d, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    labelLayer = document.getElementById('gfxLabels');
    if (!labelLayer) {
      labelLayer = document.createElement('div');
      labelLayer.id = 'gfxLabels';
      document.body.appendChild(labelLayer);
    }
    sys = buildSystem();
    bindInput(canvas);
    resize(window.innerWidth, window.innerHeight);
    ready = true;
    return true;
  }

  function resize(w, h) {
    W = w; H = h;
    if (renderer) renderer.setSize(W, H);
  }

  function insetRects(n) {
    const isz = Math.min(340, W * 0.42, H * 0.46);
    const iy = Math.max(Math.min((H - isz) / 2 + 30, H - isz - 165), 140);
    const out = [];
    for (let i = 0; i < n; i++)
      out.push({ x: i === 0 ? W - isz - 14 : 14, y: iy, s: isz });
    return out;
  }

  function render(view) {
    if (!ready) return;
    labelsBegin();
    renderer.setScissorTest(false);
    renderer.clear(true, true, false);
    renderSystem(view);

    const list = view.insets.slice(0, 2);
    const rects = insetRects(list.length);
    for (let i = 0; i < list.length; i++) {
      if (!insetViews[i]) insetViews[i] = makeInsetView(i);
      renderInset(insetViews[i], list[i], rects[i], view);
    }
    for (let i = list.length; i < insetViews.length; i++)
      insetViews[i].chrome.root.style.display = 'none';
    labelsEnd();
  }

  return { init, resize, render, get ready() { return ready; } };
})();
