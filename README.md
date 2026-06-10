# 1G — The Earth–Mars War

A web-based, hard-SF fleet combat simulation. Two hidden-information
players split their fleets between attack and defense, then watch the war
unfold under (mostly) honest physics: constant 1 g fusion-torch burns across
interplanetary distances, torpedo salvos, and point-defence cannon fire.

## Running it

No build step, no dependencies — it's plain HTML5 canvas + vanilla JS.

```sh
# either just open the file…
open index.html

# …or serve the folder
python3 -m http.server 8000   # then visit http://localhost:8000
```

## The campaign

A war is a **best-of-5-round campaign** with persistent fleets:

- Each round, both commanders secretly split their fleet between the
  **strike force** (enemy homeworld), **task forces** for **Ceres and
  Pallas Station**, and home defense. Survivors carry over.
- **Win the war outright by conquest**: a homeworld falls when its
  defenders are annihilated *or* a parked attacker holds 2:1 orbital
  supremacy over what's left.
- Otherwise rounds score points — **blockade** of the enemy homeworld
  +2 (and their shipyards build nothing next round), each **station held**
  +1 (and +1 hull of production), **winning the attrition exchange** +1.
  Highest score after 5 rounds wins; ties break on total kills, then
  surviving hulls.
- Between rounds the yards deliver new hulls (+2 base, capped at 16) and
  **60 days pass — the planets keep moving**, so Earth–Mars and belt
  transit geometry shifts every round and attack windows matter. The
  allocation screen shows live distances and 1g transit times.

## How a round plays out

1. **Earth commander (People's Fleet of Earth, PFE)** secretly splits 12
   warships between a *strike force* (sent to Mars) and defenders, then
   walks away from the console. A third of the defenders automatically
   picket Luna; the rest hold Earth orbit.
2. **Mars commander (United Mars Space Force, UMSF)** does the same for
   Mars — its picket ships split between Deimos and Phobos.
3. Both strike forces light their drives simultaneously and fly a
   **brachistochrone trajectory**: accelerate at 1 g to the midpoint, flip
   ship, decelerate at 1 g (~3 days, peaking around 1,280 km/s). The two
   strike fleets pass each other in deep space without engaging — each
   one's target is the other's homeworld.
4. On final approach each strike force **evaluates the defender's moons for
   a gravity assist**: Luna is massive enough to be worth a flyby when it
   sits on the approach side (which also brings the attacker right past the
   Luna picket); Phobos and Deimos are honestly ruled out as too small. The
   decision is reported in the event log.
5. **Moon pickets sortie** when an attacker closes within ~800,000 km,
   burning out to intercept and harass the strike force before it reaches
   the homeworld, then falling back on the main battle as a flanking force.
6. When opposing groups close to torpedo range, **combat starts
   automatically**: salvos of 50 g torpedoes, defended against by PDC fire
   (home fleets get extra engagement capacity from planetary defence
   batteries). Planets and moons are terrain — they block lines of fire,
   and torpedoes that cut the corner too tight splash on the surface.
7. A homeworld **falls** when *all* its defenders — home fleet and pickets —
   are destroyed and an enemy strike force holds orbit. Outcomes: one side
   victorious, mutual conquest, stalemate, or a cold standoff if nobody
   attacks.

## Presentation

Rendering is **real-time 3D on the GPU** (WebGL via a vendored three.js —
no CDN, no build step; software fallback message if WebGL is unavailable).

- The main view is an oblique perspective of the solar system: Sun glow and
  point-light, true orbit ellipses, textured planets with day/night
  terminators, fleet meshes with flickering drive plumes, and additive
  trajectory trails. **Drag to orbit, right-drag to pan, and scroll or
  pinch to zoom — anchored Google-Maps style at the point under the
  cursor/fingers.**
- **Always-on 3D inset viewports** for both homeworlds show their orbital
  space (home fleet, moons, pickets) at all times, zooming automatically to
  frame battles when they start. Two more **tracking insets follow each
  strike force** through transit — including Luna flybys and picket
  intercepts — with slowly drifting cinematic cameras. All insets render
  planets and moons at real scale, lit from the true sun direction, with
  ship hulls, torpedo streaks, PDC tracers, explosion blooms and a polar
  tactical grid.
- Each side's HUD panel carries a **clickable ship roster**: click any ship
  for a closeup "ship cam" inset of that vessel and its environs (click
  again or press `ESC` to dismiss; the view dies with the ship).
- A mission clock shows elapsed time (`T+ 2d 21:05:38`), and time
  **automatically warps** — up to ~×80,000 in cruise, easing down to ×3 for
  terminal torpedo defence — paced so a transit takes about a minute and a
  full war roughly three. (`SPACE` pauses, `+`/`−` overrides, `A` resumes
  auto.)
- Fleet panels, the event log, labels and inset chrome are crisp DOM
  overlays on top of the GL canvas.

## Physics & combat model

| Thing | Model |
|---|---|
| Planets | True Keplerian ellipses around the Sun (Earth e = 0.0167, Mars e = 0.0934, Ceres e = 0.0785, Pallas e = 0.23, real perihelion longitudes), solved via Newton iteration on Kepler's equation each step |
| Belt stations | Ceres and Pallas at real orbital radii and masses — task forces park in genuine (tiny) gravity-well orbits, and the rocks block torpedoes; two forces can end up wedged in a no-firing-solution standoff on opposite sides |
| Moons | Luna (384,400 km, 27.3 d), Phobos (9,376 km, 7.7 h) and Deimos (23,463 km, 30.3 h) on circular orbits with real radii and masses |
| Gravity | Sun, Earth, Mars and Luna pull on every thrusting ship and torpedo (Phobos/Deimos are real terrain but their gravity is honestly negligible) |
| Transit | True flip-and-burn at 1 g toward a moving planet, with gravity feed-forward in the braking solution; ~260,000 s for ~1.1 AU |
| Parking orbits | Strike forces circularize into a real two-body orbit on arrival (the Earth insertion burn is ~4.3 km/s); home fleets sweep around their planet at true orbital rates (~4.6 km/s in Earth orbit) |
| Terrain | Bodies block torpedo flight, target selection and PDC fire — ships on the far side of a planet are temporarily safe, and shooters hold fire until their orbit clears the shot |
| Gravity assist | Strike groups route through Luna's gravity well when geometry favours it; flybys of low-mass moons are evaluated and rejected |
| Torpedoes | 50 g constant acceleration, proportional-pursuit guidance with lead under gravity, proximity fusing (degraded at extreme closing speeds), limited magazines (8 per ship) |
| PDC defence | Time-to-impact based engagement window, saturation-aware kill rates — large salvos overwhelm point defence |
| Integration | Adaptive substeps (0.5 s in combat) with closest-approach hit tests so high warp factors never skip an impact |

Numbers worth knowing: each side has 12 ships, fires salvos of 2 torpedoes
per ship every 55 s while in range, and a ship dies to a single torpedo hit.
Defenders are favoured ship-for-ship (planetary PDC grid), so a successful
invasion needs real local superiority — but every ship sent leaves your own
orbitals thinner.

## Files

- `index.html` — markup, styles, setup/end-screen UI, HUD and overlay layers
- `sim.js` — simulation: physics, AI guidance, combat, time-warp director, HUD
- `gfx3d.js` — the WebGL renderer: system view, battle inset viewports,
  procedural planet textures, ship meshes, labels and inset chrome
- `vendor/three.min.js` — three.js r128, vendored so the game runs offline
  from a plain `file://` open
