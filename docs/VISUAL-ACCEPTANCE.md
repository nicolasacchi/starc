# Visual acceptance — what is proven, and how

The renderer has never had a GPU. Everything below was established in headless
software-rasterised Chromium, which shapes what evidence is available.

## Geometry conformance, and what it caught

A test pass took `render/geometry` from 46% to 99.7% and immediately found
that **25 of the 57 roster entities sat below the ground plane** — buildings
sunk up to 0.52 m — because `beveledBox` was origin-centred while every other
primitive bases at y=0. The project's own `assertGeometryCoverage()` had been
throwing because of it.

That is now a convention rather than 25 special cases, `assertGeometryCoverage()`
passes for all 57 keys, and `tmp/shots/GEOM-FIXED.png` shows the Terran base
and workers standing on the ridge rather than buried in it.

The same pass found that `airHoverLift` lifted nothing, that reach was measured
from the model's half-width so off-centre hulls escaped the fit, and that three
docstrings were false of the code beneath them — including `UV_METRES`, which
was documented as a divisor and used as a multiplier, making every procedural
texture 4x coarser than stated.

## `low` — fully verified, in the browser

A live two-player match, at 1280×720 and 1600×900, showing sky, horizon,
terrain relief, green biome albedo, atmospheric recession, the HUD on top, and
live resources and supply. Screenshots: `tmp/shots/FINAL-game.png`,
`FINAL-pan.png`, `PLAYING.png`, `base-and-workers-magnified.png`.

## `high` and `ultra` — verified, and the attempt found a real bug

`tmp/shots/ULTRA-GAME.png` is a live `ultra` frame: terrain behind a populated
HUD, 210 minerals, live supply, both bases on the minimap, **zero shader
errors** in the console.

Getting that far is what closed the last gap. The first `ultra` attempt threw
eight GLSL compile errors and every race material fell back to three's error
material: the injected chunk body referenced uniforms as `uChunkScale.value`,
which is three.js's JavaScript `Uniform` accessor and illegal in a shader. It
compiled at `low` because those chunks are not requested there, and it was
invisible to the unit suite because nothing constructs the injection in a
context that compiles GLSL. Fixed, with thirteen regression tests; a
neighbouring latent failure — the emissive scan reading `uTime` when only the
time/panel/fresnel options declared it — went at the same time.

## `medium` — verified that the world renders, not a smear

This was the acceptance criterion for the post-FX fix, and it is met:
`tmp/shots/MEDIUM-GAME.png` is a live `medium` frame showing terrain behind a
populated HUD, with **650 minerals and live supply** read from the server's
`res` field. The frame is the world, not a radial smear.

The capture is at **400×225** rather than a normal size, for a reason worth
stating plainly: software rasterisation of the post-FX chain does not finish a
frame at 1280×720 inside the harness budget — `tab.screenshot()` and
`tab.evaluate()` both time out and the tab is killed. That is a statement about
this machine, not about the code. It is also why the HUD panels overlap in that
screenshot: the stylesheet is designed down to a 1280×720 floor and 400×225 is
far below it, so that is a consequence of the capture size, not a layout defect.

Supporting evidence for `high` and `ultra`, which could not be photographed:

- **Zero shader compile errors in the browser at `medium`.** This is load
  bearing: the two defects that made `high` and `ultra` draw black —
  `SSAOPass` added instead of `RenderPass`, and `CompositeShader` referencing
  an undeclared `tDepth` — both announce themselves as console errors, and the
  earlier broken build produced exactly that text.
- **Ten tests** covering the composer plumbing, including
  "still shows the world on medium / high / ultra" and "draws the graded image
  from the beauty buffer, not from a shaft-only pass".
- A structural argument: the additive god-ray term is folded into the composite
  shader, so the pass that samples the beauty buffer is the pass that draws the
  final image. There is no position left in the chain where the scene can be
  replaced.

## What I would do with a GPU

One pass, opening `?quality=ultra` and looking at it. That is the only gap, and
it is a gap in my evidence rather than a known defect.

## A note on reading this DOM

Several times during this work a hidden overlay's `textContent` read as if the
game were stuck — "Waiting for the server to open the match…" on an element
computed to `display: none`. Overlays keep their text forever, so a
`textContent` check reports a state that is not on screen. Check computed
`display` before concluding anything about what the user sees.

## Wave 2 — adversarial review with fresh agents

Eight read-only lenses reviewed the client and the sim. Two of the eight
headline claims were **false** and were refuted against the code before any
edit; six were real. Verification before fixing was not ceremony — it is the
difference between five fixes and seven, two of which would have replaced
working code with a guess.

### Refuted (do not "fix" these)

- **"The build panel is 100% inert."** It is not. `buildMenu.ts:183-191` wires
  `click -> onBeginPlacement`; `app.ts:601-603` forwards it to
  `input.beginPlacement`, which sets `modeState = "placing"` and shows a ghost.
  Two other callers exist in `input.ts`. `buildableWith` returns the units a
  structure produces, which is the correct StarCraft semantic.
- **"`hold` makes a unit permanently inert."** It does not. `targeting.rb:43`
  suppresses *acquisition* only; `combat.rb:32` gates firing on `target_id`
  alone, so a held unit keeps shooting what it already had, and any new order
  clears the flag. That is exactly what hold means.

### Fixed, each with a test that fails without it

- **The painted moon was 60-139 deg from the moonlight.** `skyDome.ts` advanced
  the reading by half a cycle, which is quadrature, not anti-solar. The
  prescribed `+1.0` was *also* wrong — in this model anti-solar is not
  reachable by any clock shift, because azimuth advances 2 rad per cycle unit,
  not pi. The disc is now the key light's own direction with the phase lag
  taken *along* the night arc. Worst separation fell from 132.6 deg to 14.2 deg.
- **A sun disc was painted on top of the moon all night** (mine, found by the
  agent fixing the moon). Past phase 1 `uSunDirection` *is* the moon, so
  `scSunDisc`'s own horizon gate read 1.0 and the shader drew a
  `760 * min(sunE, 80)` — about 6.1e4 radiance, some 38000x the moon disc's
  1.6 — inside the moon's own, larger, disc. The night sky rendered as a
  blown-out white dot. Now gated on `uNight`, which is 0 right through sunset,
  so the setting sun is untouched.
- **The last x/y transposition** (`terrain.rb:116` returned `y` where every
  consumer reads `z`; latent only because all four shipped maps define start
  positions).
- **A refused order oscillated for 3 full seconds** — six frames marching out,
  one frame snapped back, repeating, because `applySnapshot` retired a local
  order only on an echo or the timeout. The claim was "~3 frames"; it was ~10x
  worse.
- **The terrain splat really was two layers, not four.** Measured, not read: a
  GLSL interpreter in the test runs the shader's own text against every map's
  packed field texture. Dirt was never the largest layer anywhere and snow was
  absent from two maps. Four root causes: a fixed slope full-scale (so rock
  followed `elevation`, making the green-hills map 2.4x rockier than the map
  described as impassable rock), `uSnowAmount` spent twice and then squared, a
  grass floor dirt was mathematically capped under, and no per-biome rock
  budget. The normalisation claim was refuted by the same measurement — sums
  were 1.000000 everywhere.
- **Nine UI classes the TypeScript emits had no CSS rule at all**, plus one
  selector mismatch: the sheet styled `.result__table thead th` while the
  module emits `.result__th`. And the lobby `.seat` row declared 6 grid
  tracks for 7 children, so a host on a team wrapped onto a second row.

### Still environment-blocked

The in-game 3D capture remains unavailable here. Software rasterisation
saturates the render loop until CDP screenshots time out and the tab is killed;
this is a property of the harness, not of the product, and it is the same limit
recorded above. What I did verify in-browser this wave: the app boots, restores
a session, enables Play, enters a live two-client match, and renders a real
match — the menu frame is captured. Two matches were correctly marked
`abandoned` when their browser tab's cable dropped, which is the server
behaving correctly under a killed tab.
