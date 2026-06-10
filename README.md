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

## How a game plays out

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

- A mission clock shows elapsed time (`T+ 2d 21:05:38`).
- Time **automatically warps** — up to ~×100,000 during the dull cruise,
  easing down to ×3 for terminal torpedo defence — so a three-day war plays
  out in about two minutes. (`SPACE` pauses, `+`/`−` overrides the warp,
  `A` returns to automatic.)
- Active engagements get **zoomed inset windows** showing individual ships,
  torpedo tracks, PDC tracers, and any planets or moons in frame (with moon
  orbit guides and range rings).
- The main view shows the Sun, both planetary orbit ellipses (planets move
  during the transit), drive plumes, and the curved trajectory trails of
  each strike group — including the dogleg of a Luna gravity-assist
  approach.

## Physics & combat model

| Thing | Model |
|---|---|
| Planets | True Keplerian ellipses around the Sun (Earth e = 0.0167, Mars e = 0.0934, real perihelion longitudes), solved via Newton iteration on Kepler's equation each step |
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

- `index.html` — markup, styles, setup/end-screen UI
- `sim.js` — everything else: physics, AI guidance, combat, time-warp
  director, rendering, HUD
