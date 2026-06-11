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
  const insetMap = new Map();     // inset descriptor id -> pooled InsetView
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
  // try to upgrade to a real texture (NASA imagery vendored in the repo);
  // fails quietly under file:// (canvas security) or headless — the
  // procedural fallback below stays in place
  function tryLoad(url, cb) {
    try {
      new THREE.TextureLoader().load(url, t => cb(t), undefined, () => {});
    } catch (e) { /* keep procedural */ }
  }

  /* ---------------- procedural planet surfaces (fBM noise) ---------------- */
  function makeNoise(seed) {
    const R = mulberry(seed);
    const N = 128;
    const g = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) g[i] = R();
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const x0 = ((xi % N) + N) % N, x1 = (x0 + 1) % N;
      const y0 = ((yi % N) + N) % N, y1 = (y0 + 1) % N;
      const a = g[y0 * N + x0], b = g[y0 * N + x1], c = g[y1 * N + x0], d = g[y1 * N + x1];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  }
  function fbm(n, x, y, oct) {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < oct; o++) { v += amp * n(x * f, y * f); amp *= 0.5; f *= 2; }
    return v;
  }

  const SURFACES = {};
  function planetSurface(kind) {
    if (SURFACES[kind]) return SURFACES[kind];
    const Wt = (kind === 'earth' || kind === 'mars') ? 1024 : 512, Ht = Wt / 2;
    const seed = { earth: 71, mars: 12, moon: 5, rock: 99, rock2: 47 }[kind] || 7;
    const n = makeNoise(seed), n2 = makeNoise(seed + 1000);
    const elev = new Float32Array(Wt * Ht);
    for (let y = 0; y < Ht; y++) {
      for (let x = 0; x < Wt; x++) {
        // mirror-fold u so the texture wraps seamlessly
        const u = (x < Wt / 2 ? x : Wt - x) / Wt * 40;
        const v = y / Ht * 20;
        elev[y * Wt + x] = fbm(n, u, v, 5);
      }
    }
    // craters for airless bodies
    if (kind !== 'earth' && kind !== 'mars') {
      const R = mulberry(seed + 7);
      const count = 110;
      for (let c = 0; c < count; c++) {
        const cx = R() * Wt, cy = Ht * 0.08 + R() * Ht * 0.84, cr = 3 + R() * R() * 26;
        const depth = 0.12 + R() * 0.2;
        for (let y = Math.max(0, cy - cr | 0); y < Math.min(Ht, cy + cr); y++)
          for (let x = Math.max(0, cx - cr | 0); x < Math.min(Wt, cx + cr); x++) {
            const d = Math.hypot(x - cx, y - cy) / cr;
            if (d > 1) continue;
            // bowl with a raised rim
            const prof = d < 0.78 ? -depth * (1 - d / 0.78) : depth * 0.7 * (1 - Math.abs(d - 0.89) / 0.11);
            elev[y * Wt + x] += prof;
          }
      }
    }
    const img = new Uint8ClampedArray(Wt * Ht * 4);
    const bmp = new Uint8ClampedArray(Wt * Ht * 4);
    const mix = (a, b, t) => a + (b - a) * Math.min(Math.max(t, 0), 1);
    for (let y = 0; y < Ht; y++) {
      const lat = Math.abs(y / Ht * 2 - 1);
      for (let x = 0; x < Wt; x++) {
        const i = y * Wt + x, e = elev[i];
        const u = (x < Wt / 2 ? x : Wt - x) / Wt * 12, v = y / Ht * 6;
        const big = fbm(n2, u, v, 3);          // continental-scale variation
        let r, g, b;
        if (kind === 'earth') {
          if (e < 0.5) { const t = e / 0.5; r = mix(8, 24, t); g = mix(38, 92, t); b = mix(92, 168, t); }
          else { const t = (e - 0.5) / 0.5; r = mix(58, 152, t); g = mix(108, 134, t); b = mix(48, 88, t); }
          if (lat > 0.82 + 0.05 * (big - 0.5)) { r = 238; g = 244; b = 250; }
        } else if (kind === 'mars') {
          const t = (e - 0.2) / 0.6;
          r = mix(96, 201, t); g = mix(40, 115, t); b = mix(24, 68, t);
          if (big < 0.42) { r *= 0.72; g *= 0.7; b *= 0.7; }     // dark maria
          const cap = 0.86 + 0.05 * (big - 0.5);
          if (lat > cap) { const s = Math.min((lat - cap) / 0.04, 1); r = mix(r, 242, s); g = mix(g, 238, s); b = mix(b, 232, s); }
        } else if (kind === 'moon') {
          let gr = 92 + 120 * (e - 0.2);
          if (big < 0.44) gr *= 0.72;                            // maria
          r = gr; g = gr; b = gr * 1.03;
        } else {                                                  // rock / rock2
          const base = kind === 'rock2' ? [88, 93, 99] : [112, 100, 85];
          const s = 0.45 + 0.9 * e;
          r = base[0] * s; g = base[1] * s; b = base[2] * s;
        }
        img[i * 4] = r; img[i * 4 + 1] = g; img[i * 4 + 2] = b; img[i * 4 + 3] = 255;
        const h = Math.min(Math.max(e, 0), 1) * 255;
        bmp[i * 4] = h; bmp[i * 4 + 1] = h; bmp[i * 4 + 2] = h; bmp[i * 4 + 3] = 255;
      }
    }
    if (kind === 'rock') {                     // Ceres' bright Occator spots
      const spots = [[0.31, 0.42], [0.33, 0.44], [0.68, 0.55]];
      for (const [sx, sy] of spots)
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 5) continue;
          const i = ((sy * Ht | 0) + dy) * Wt + ((sx * Wt | 0) + dx);
          img[i * 4] = 235; img[i * 4 + 1] = 235; img[i * 4 + 2] = 228;
        }
    }
    const toTex = data => {
      const c = makeCanvas(Wt, Ht);
      c.getContext('2d').putImageData(new ImageData(data, Wt, Ht), 0, 0);
      return new THREE.CanvasTexture(c);
    };
    SURFACES[kind] = { map: toTex(img), bump: toTex(bmp) };
    return SURFACES[kind];
  }

  function cloudTexFallback() {
    const c = makeCanvas(512, 256), x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 512, 256);
    const R = mulberry(33);
    x.fillStyle = '#fff';
    for (let i = 0; i < 90; i++) {
      x.globalAlpha = 0.05 + R() * 0.2;
      x.save();
      x.translate(R() * 512, R() * 256); x.rotate(R() * 3);
      x.beginPath(); x.ellipse(0, 0, 14 + R() * 70, 4 + R() * 14, 0, 0, TAU); x.fill();
      x.restore();
    }
    return new THREE.CanvasTexture(c);
  }

  // shared materials, upgraded asynchronously with real NASA imagery
  const MATS = {};
  function planetMat(kind) {
    if (MATS[kind]) return MATS[kind];
    const s = planetSurface(kind);
    const m = new THREE.MeshPhongMaterial({
      map: s.map, bumpMap: s.bump, bumpScale: 0.035,
      emissive: 0x141a24, shininess: kind === 'earth' ? 16 : 4, specular: 0x1c222c
    });
    if (kind === 'earth') {
      tryLoad('vendor/textures/earth.jpg', t => { m.map = t; m.needsUpdate = true; });
      tryLoad('vendor/textures/earth-bump.png', t => { m.bumpMap = t; m.needsUpdate = true; });
      tryLoad('vendor/textures/earth-water.png', t => {
        m.specularMap = t;
        m.specular = new THREE.Color(0x8fb3d9);
        m.shininess = 26;
        m.needsUpdate = true;
      });
    }
    MATS[kind] = m;
    return m;
  }

  let cloudMat = null;
  function addClouds(mesh, radius) {
    if (!cloudMat) {
      cloudMat = new THREE.MeshLambertMaterial({
        map: cloudTexFallback(), transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      tryLoad('vendor/textures/clouds.jpg', t => { cloudMat.map = t; cloudMat.needsUpdate = true; });
    }
    const cm = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.018, 40, 24), cloudMat);
    mesh.add(cm);
    mesh.userData.clouds = cm;
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

    // Milky Way backdrop (NASA Tycho catalog skymap, dimmed to keep contrast)
    tryLoad('vendor/textures/starmap.jpg', t => {
      const sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 48, 24),
        new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, color: 0x55606e, depthWrite: false }));
      sky.rotation.set(0.9, 0, 0.35);
      scene.add(sky);
    });

    // sun
    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex('rgba(255,225,160,1)'), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffd9a0
    }));
    sunGlow.scale.set(85, 85, 1);
    scene.add(sunGlow);
    tryLoad('vendor/textures/sun.png', t => {
      sunGlow.material.map = t;
      sunGlow.material.needsUpdate = true;
    });
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

    // planets, belt stations, defense rings
    const planetMeshes = new Map(), defRings = new Map(), planetGlows = new Map();
    for (const p of env.planets) {
      const kind = p.name === 'Earth' ? 'earth' : p.name === 'Mars' ? 'mars'
        : p.name === 'Ceres' ? 'rock' : 'rock2';
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.sysR || 2, 48, 28), planetMat(kind));
      if (kind === 'earth') addClouds(mesh, p.sysR || 2);
      scene.add(mesh);
      planetMeshes.set(p.name, mesh);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex('rgba(255,255,255,1)'), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, color: p.color, opacity: 0.4
      }));
      glow.scale.setScalar((p.sysR || 2) * 4.1);
      scene.add(glow);
      planetGlows.set(p.name, glow);
      if (!p.sideKey) continue;          // only the homeworlds carry defense rings
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

    const cam = new THREE.PerspectiveCamera(45, W / H, 0.2, 12000);
    const camState = { azim: -1.15, elev: 0.62, dist: 760, tx: 0, tz: 0 };

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
  function sysShip(i, color) {
    const arr = sys.homeShips || (sys.homeShips = []);
    if (!arr[i]) {
      arr[i] = buildShip(0xffffff);
      sys.scene.add(arr[i]);
    }
    const m = arr[i];
    m.visible = true;
    m.userData.mat.color.set(color);
    m.userData.mat.emissive.set(color).multiplyScalar(0.28);
    return m;
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
    // camera from input state (orbits a movable target on the ecliptic)
    const cs = S.camState;
    S.cam.position.set(
      cs.tx + Math.cos(cs.azim) * Math.cos(cs.elev) * cs.dist,
      Math.sin(cs.elev) * cs.dist,
      cs.tz + Math.sin(cs.azim) * Math.cos(cs.elev) * cs.dist);
    S.cam.lookAt(cs.tx, 0, cs.tz);
    S.cam.aspect = W / H;
    S.cam.updateProjectionMatrix();
    S.cam.updateMatrixWorld();
    S.cam.matrixWorldInverse.copy(S.cam.matrixWorld).invert();

    S.sunGlow.scale.setScalar(82 + 5 * Math.sin(view.wallNow * 1.3));

    for (const p of env.planets) {
      const m = S.planetMeshes.get(p.name);
      m.position.set(p.pos.x / SYS, 0, p.pos.y / SYS);
      m.rotation.y = view.simTime / (p.rotPeriod || 86400) * TAU;
      if (m.userData.clouds) m.userData.clouds.rotation.y = view.simTime / 86400 * TAU * -0.32;
      const glow = S.planetGlows.get(p.name);
      glow.position.copy(m.position);
      glow.material.opacity = 0.4 * Math.min(Math.max((cs.dist - 60) / 400, 0.08), 1);
      const sp = project(m.position, S.cam, 0, 0, W, H);
      if (sp) label('pl-' + p.name, sp.x, sp.y - 22, p.name.toUpperCase(), 'rgba(200,220,255,0.8)', 10);
      if (!p.sideKey) continue;
      const ring = S.defRings.get(p.name);
      ring.position.copy(m.position);
      const home = view.groups.find(g => g.side === p.sideKey && g.role === 'defense');
      const n = home ? env.helpers.aliveCount(home) : 0;
      ring.visible = !!home && home.count0 > 0;
      ring.material.color.set(n > 0 ? env.SIDES[p.sideKey].color : 0x5a6a85);
      ring.material.opacity = n > 0 ? 0.4 : 0.15;
      if (sp && home && home.count0 > 0)
        label('home-' + p.name, sp.x, sp.y + 22,
          n > 0 ? `HOME ${n}` : 'HOME ✕',
          n > 0 ? env.SIDES[p.sideKey].color : '#5a6a85', 9);
    }

    // strike fleets + trails (markers keep constant screen size and stay
    // clear of the visually exaggerated planet spheres)
    const mScale = Math.min(Math.max(cs.dist * 0.0028, 0.5), 4.5);
    for (const g of view.attackGroups) {
      const alive = env.helpers.aliveCount(g) > 0;
      const f = sysFleet(g);
      f.visible = alive;
      if (alive) {
        f.position.set(g.pos.x / SYS, 0, g.pos.y / SYS);
        f.scale.setScalar(mScale);
        for (const p of env.planets) {
          const px = p.pos.x / SYS, pz = p.pos.y / SYS;
          const dx = f.position.x - px, dz = f.position.z - pz;
          const dd = Math.hypot(dx, dz);
          const minR = (p.sysR || 2) + mScale * 1.7;
          if (dd < minR) {
            const ux = dd > 1e-6 ? dx / dd : 1, uz = dd > 1e-6 ? dz / dd : 0;
            f.position.x = px + ux * minR;
            f.position.z = pz + uz * minR;
            break;
          }
        }
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

    // home fleets & moon pickets resolve into individual ships as you zoom
    // in, riding the visual defense ring (their true orbits sit inside the
    // exaggerated planet sphere)
    let hi = 0;
    if (cs.dist < 420) {
      const ZP = new THREE.Vector3(0, 0, 1);
      for (const g of view.groups) {
        if (hi >= 34) break;
        const station = g.role === 'defense' || (g.role === 'picket' && g.mode === 'station');
        if (!station || env.helpers.aliveCount(g) === 0) continue;
        const pl = g.planetHome;
        const px = pl.pos.x / SYS, pz = pl.pos.y / SYS;
        const ringR = g.role === 'defense' ? 4.09 : (pl.sysR || 2) + 2.9;
        const ships = env.helpers.aliveShips(g);
        for (let k = 0; k < ships.length && hi < 34; k++) {
          const sp = env.helpers.shipPos(g, ships[k]);
          let ux = sp.x - pl.pos.x, uy = sp.y - pl.pos.y;
          const l = Math.hypot(ux, uy) || 1;
          ux /= l; uy /= l;
          // pickets share one bearing (their moon) — fan them out slightly
          let ang = Math.atan2(uy, ux);
          if (g.role === 'picket') ang += (k - (ships.length - 1) / 2) * 0.1;
          const m = sysShip(hi++, env.SIDES[g.side].color);
          m.position.set(px + Math.cos(ang) * ringR, 0, pz + Math.sin(ang) * ringR);
          m.quaternion.setFromUnitVectors(ZP, new THREE.Vector3(-Math.sin(ang), 0, Math.cos(ang)));
          m.scale.setScalar(mScale * 0.55);
          m.userData.plume.visible = false;
        }
      }
    }
    if (sys.homeShips) for (let i = hi; i < sys.homeShips.length; i++) sys.homeShips[i].visible = false;

    // battle reticles
    const rScale = Math.min(Math.max(cs.dist / 760, 0.2), 2);
    let ri = 0;
    for (const bt of view.battles) {
      if (bt.done || ri >= S.reticles.length) continue;
      const r = S.reticles[ri++];
      r.visible = true;
      r.position.set((bt.a.pos.x + bt.b.pos.x) / 2 / SYS, 0, (bt.a.pos.y + bt.b.pos.y) / 2 / SYS);
      r.scale.setScalar((9 + 2.4 * Math.sin(view.wallNow * 5)) * rScale);
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
    scene.add(new THREE.AmbientLight(0x3b4254, 1.0));
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
        : b.name === 'Luna' ? 'moon' : b.name === 'Pallas' ? 'rock2' : 'rock';
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), planetMat(kind));
      if (kind === 'earth') addClouds(mesh, 1);
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

  function shipHeading(g, sh) {
    let base = null;
    if (g.role === 'defense') base = g.planetHome.vel;
    else if (g.role === 'picket' && g.mode === 'station') base = g.moon.vel;
    else if (g.role === 'strike' && g.phase === 'parked') base = g.planetTarget.vel;
    else return g.aim;
    const v = env.helpers.shipVel(g, sh);
    const dx = v.x - base.x, dy = v.y - base.y;
    const l = Math.hypot(dx, dy);
    return l > 1 ? { x: dx / l, y: dy / l } : g.fdir;
  }

  function renderInset(iv, desc, rect, view) {
    const H_ = env.helpers;
    const cx = desc.cx, cy = desc.cy;
    iv.half = iv.half == null ? desc.half
      : iv.half + (desc.half - iv.half) * (1 - Math.exp(-1.8 * view.dtWall));
    const halfU = iv.half / BTL;
    const toL = p => new THREE.Vector3((p.x - cx) / BTL, 0, (p.y - cy) / BTL);
    const ZP = new THREE.Vector3(0, 0, 1);

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
      mesh.rotation.y = view.simTime / (body.rotPeriod || 1e5) * TAU;
      if (mesh.userData.clouds) mesh.userData.clouds.rotation.y = view.simTime / 86400 * TAU * -0.32;
      if (rim) { rim.position.copy(lp); rim.scale.setScalar(r); }
      const sp = project(lp, iv.cam, rect.x, rect.y, rect.s, rect.s);
      if (sp && body.parent)
        label('iv' + iv.idx + '-' + body.name, sp.x, sp.y - r / halfU * rect.s * 0.55 - 8,
          body.name.toUpperCase(), 'rgba(170,190,220,0.7)', 8);
    }

    // ships: every group inside this region
    const shipScale = halfU * 0.045 * (desc.zoomShips || 1);
    let si = 0;
    for (const g of view.groups) {
      if (H_.aliveCount(g) === 0) continue;
      if (Math.hypot(g.pos.x - cx, g.pos.y - cy) > iv.half * 2.2) continue;
      const color = env.SIDES[g.side].color;
      const thrustOn = g.thrusting && (g.role === 'strike' || (g.role === 'picket' && g.mode !== 'station'));
      for (const sh of H_.aliveShips(g)) {
        if (si >= 28) break;
        const m = insetShip(iv, si++, color);
        m.position.copy(toL(H_.shipPos(g, sh)));
        const dir = shipHeading(g, sh);
        m.quaternion.setFromUnitVectors(ZP, new THREE.Vector3(dir.x, 0, dir.y).normalize());
        m.scale.setScalar(shipScale);
        const pl = m.userData.plume;
        pl.visible = thrustOn;
        if (pl.visible) pl.scale.set(1, 1, 0.7 + Math.random() * 0.6);
      }
    }
    for (; si < iv.ships.length; si++) if (iv.ships[si]) iv.ships[si].visible = false;

    // torpedoes from every battle, spatially culled
    const pa = iv.torps.geometry.attributes.position.array;
    const ca = iv.torps.geometry.attributes.color.array;
    const tpa = iv.torpTrails.geometry.attributes.position.array;
    const tca = iv.torpTrails.geometry.attributes.color.array;
    const ra = iv.tracers.geometry.attributes.position.array;
    let ti = 0, rj = 0;
    const cullR = iv.half * 1.9;
    for (const bt of view.battles) {
      if (bt.done) continue;
      const fvx = (bt.a.vel.x + bt.b.vel.x) / 2, fvy = (bt.a.vel.y + bt.b.vel.y) / 2;
      for (const t of bt.torps) {
        if (!t.alive) continue;
        if (Math.hypot(t.pos.x - cx, t.pos.y - cy) > cullR) continue;
        if (ti < 400) {
          const lp = toL(t.pos);
          pa[ti * 3] = lp.x; pa[ti * 3 + 1] = 0; pa[ti * 3 + 2] = lp.z;
          const col = new THREE.Color(t.side === 'earth' ? 0xbfe0ff : 0xffc4a8);
          ca[ti * 3] = col.r; ca[ti * 3 + 1] = col.g; ca[ti * 3 + 2] = col.b;
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
        if (t.engaged && rj < 240) {
          const defenders = H_.aliveShips(t.tGroup);
          if (defenders.length) {
            const src = defenders[(t.id * 7 + Math.floor(view.wallNow * 9)) % defenders.length];
            const a = toL(H_.shipPos(t.tGroup, src)), b = toL(t.pos);
            const j = halfU * 0.01;
            ra[rj * 6] = a.x; ra[rj * 6 + 1] = 0; ra[rj * 6 + 2] = a.z;
            ra[rj * 6 + 3] = b.x + (Math.random() - 0.5) * j;
            ra[rj * 6 + 4] = (Math.random() - 0.5) * j * 0.4;
            ra[rj * 6 + 5] = b.z + (Math.random() - 0.5) * j;
            rj++;
          }
        }
      }
    }
    iv.torps.geometry.setDrawRange(0, ti);
    iv.torps.geometry.attributes.position.needsUpdate = true;
    iv.torps.geometry.attributes.color.needsUpdate = true;
    iv.torpTrails.geometry.setDrawRange(0, ti * 2);
    iv.torpTrails.geometry.attributes.position.needsUpdate = true;
    iv.torpTrails.geometry.attributes.color.needsUpdate = true;
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
    c.title.textContent = desc.title;
    c.range.textContent = '\u2300 ' + env.helpers.fmtKm(iv.half * 2);
    if (desc.battle) {
      const bt = desc.battle;
      c.la.textContent = `${env.SIDES[bt.a.side].navy} ${H_.aliveCount(bt.a)}`;
      c.la.style.color = env.SIDES[bt.a.side].color;
      c.lb.textContent = `${H_.aliveCount(bt.b)} ${env.SIDES[bt.b.side].navy}`;
      c.lb.style.color = env.SIDES[bt.b.side].color;
    } else {
      c.la.textContent = '';
      c.lb.textContent = '';
    }

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

  /* ---------------- input: orbit, pan, anchored zoom & pinch ---------------- */
  // Google-Maps-style zoom: the world point under the cursor (or pinch
  // midpoint) stays fixed on screen while the camera scales toward it.
  function planePoint(px, py) {
    const cam = sys.cam;
    const origin = cam.position.clone();
    const dir = new THREE.Vector3(px / W * 2 - 1, -(py / H) * 2 + 1, 0.5)
      .unproject(cam).sub(origin).normalize();
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = -origin.y / dir.y;
    if (t <= 0) return null;
    return origin.addScaledVector(dir, t);
  }
  function clampTarget(cs) {
    cs.tx = Math.min(Math.max(cs.tx, -600), 600);
    cs.tz = Math.min(Math.max(cs.tz, -600), 600);
  }
  function zoomAt(px, py, k) {
    const cs = sys.camState;
    const nd = Math.min(Math.max(cs.dist * k, 28), 2600);
    k = nd / cs.dist;
    const P = planePoint(px, py);
    cs.dist = nd;
    if (P) {
      cs.tx = P.x + (cs.tx - P.x) * k;
      cs.tz = P.z + (cs.tz - P.z) * k;
      clampTarget(cs);
    }
  }
  function panBetween(ax, ay, bx, by) {
    const A = planePoint(ax, ay), B = planePoint(bx, by);
    if (!A || !B) return;
    const cs = sys.camState;
    cs.tx += A.x - B.x;
    cs.tz += A.z - B.z;
    clampTarget(cs);
  }
  function bindInput(canvas) {
    const pts = new Map();          // active pointers
    let pinch = null;               // {d, mx, my}
    let last = null;                // single-pointer drag anchor {x, y, pan}
    canvas.addEventListener('pointerdown', e => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pts.size === 1) last = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey };
      pinch = null;
    });
    canvas.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (pinch) {
          zoomAt(mx, my, pinch.d / d);          // spread fingers => zoom in
          panBetween(pinch.mx, pinch.my, mx, my);
        }
        pinch = { d, mx, my };
        last = null;
      } else if (pts.size === 1 && last) {
        if (last.pan) {
          panBetween(last.x, last.y, e.clientX, e.clientY);
        } else {
          const cs = sys.camState;
          cs.azim += (e.clientX - last.x) * 0.005;
          cs.elev = Math.min(Math.max(cs.elev + (e.clientY - last.y) * 0.004, 0.12), 1.45);
        }
        last = { x: e.clientX, y: e.clientY, pan: last.pan };
      }
    });
    const drop = e => {
      pts.delete(e.pointerId);
      pinch = null;
      last = pts.size === 1 ? { ...[...pts.values()][0], pan: false } : null;
    };
    canvas.addEventListener('pointerup', drop);
    canvas.addEventListener('pointercancel', drop);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0012));
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

  // two stacked columns under the HUD panels: Earth-side views on the
  // left, Mars-side on the right; drop low-priority views that don't fit
  function insetRects(list) {
    const cols = [[], []];
    for (const d of list) cols[d.col === 1 ? 1 : 0].push(d);
    const topFor = id => {
      const el = document.getElementById(id);
      return Math.max(150, ((el && el.offsetHeight) || 120) + 26);
    };
    const tops = [topFor('panelL'), topFor('panelR')];
    const avail = H - Math.max(tops[0], tops[1]) - 170;   // keep clear of the log
    const maxRows = Math.max(1, Math.floor(avail / 158));
    cols[0] = cols[0].slice(0, maxRows);
    cols[1] = cols[1].slice(0, maxRows);
    const rows = Math.max(cols[0].length, cols[1].length, 1);
    const isz = Math.min(300, W * 0.30, Math.max(avail / rows - 12, 146));
    const out = new Map();
    cols.forEach((arr, c) => arr.forEach((d, r) =>
      out.set(d.id, { x: c === 0 ? 14 : W - isz - 14, y: tops[c] + r * (isz + 12), s: isz })));
    return out;
  }

  function render(view) {
    if (!ready) return;
    labelsBegin();
    renderer.setScissorTest(false);
    renderer.clear(true, true, false);
    renderSystem(view);

    const list = view.insets.slice(0, 6);
    const rects = insetRects(list);
    const used = new Set();
    for (const desc of list) {
      const rect = rects.get(desc.id);
      if (!rect) continue;                  // didn't fit on screen this frame
      let iv = insetMap.get(desc.id);
      if (!iv) { iv = makeInsetView(insetMap.size); insetMap.set(desc.id, iv); }
      used.add(desc.id);
      renderInset(iv, desc, rect, view);
    }
    for (const [id, iv] of insetMap)
      if (!used.has(id)) iv.chrome.root.style.display = 'none';
    labelsEnd();
  }

  return { init, resize, render, get ready() { return ready; } };
})();
