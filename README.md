# 1G — The Earth–Mars War

A web-based, *Expanse*-style fleet combat simulation. Two hidden-information
players split their fleets between attack and defense, then watch the war
unfold under (mostly) honest physics: constant 1 g Epstein-drive burns across
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

1. **Earth commander (UNN)** secretly splits 12 warships between a *strike
   force* (sent to Mars) and a *home fleet* (holds Earth orbit), then walks
   away from the console.
2. **Mars commander (MCRN)** does the same for Mars.
3. Both strike forces light their drives simultaneously and fly a
   **brachistochrone trajectory**: accelerate at 1 g to the midpoint, flip
   ship, decelerate at 1 g, and brake into a standoff orbit at the enemy
   world (~2.9 days, peaking around 1,200 km/s). The two strike fleets pass
   each other in deep space without engaging — each one's target is the
   other's homeworld.
4. When a strike force closes to torpedo range of the defending home fleet,
   **combat starts automatically**: salvos of 50 g torpedoes, defended
   against by PDC fire (home fleets get extra engagement capacity from
   planetary defence batteries).
5. A homeworld **falls** when its defenders are destroyed and an enemy
   strike force holds station in orbit. Outcomes: one side victorious,
   mutual conquest, stalemate, or a cold standoff if nobody attacks.

## Presentation

- A mission clock shows elapsed time (`T+ 2d 21:05:38`).
- Time **automatically warps** — up to ~×100,000 during the dull cruise,
  easing down to ×3 for terminal torpedo defence — so a three-day war plays
  out in about two minutes. (`SPACE` pauses, `+`/`−` overrides the warp,
  `A` returns to automatic.)
- Active engagements get **zoomed inset windows** showing individual ships,
  torpedo tracks, PDC tracers, and the planet itself, with range rings.
- The main view shows the Sun, both planetary orbits (planets move during
  the transit), drive plumes, and the curved trajectory trails of each
  strike group.

## Physics & combat model

| Thing | Model |
|---|---|
| Transit | True flip-and-burn at 1 g toward a moving planet, with lateral velocity null-out; ~250,000 s for ~1.05 AU |
| Planets | Circular heliocentric orbits at correct radii and angular rates |
| Torpedoes | 50 g constant acceleration, proportional-pursuit guidance with lead, proximity fusing (degraded at extreme closing speeds), limited magazines (8 per ship) |
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
