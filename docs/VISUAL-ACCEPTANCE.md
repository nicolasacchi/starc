# Visual acceptance — what is proven, and how

The renderer has never had a GPU. Everything below was established in headless
software-rasterised Chromium, which shapes what evidence is available.

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
