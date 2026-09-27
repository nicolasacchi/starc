/**
 * Inline SVG glyphs for the whole 57-entry roster.
 *
 * Every icon is drawn from primitives into a real `SVGSVGElement` — there is no
 * sprite sheet, no data-URI, no font, no image file. The template for a
 * `key:size` pair is built once and cached; each call returns a `cloneNode`
 * copy so the same glyph can live in the command card, the build menu and the
 * inspector at the same time.
 *
 * Colours come from the document (`currentColor` plus the `--icon-accent`
 * custom property), so a glyph is tinted by CSS rather than baked in.
 *
 * Headless use: nothing is built at module scope. If `document` is missing
 * (Vitest `environment: "node"`), inject one with `setIconDocument()`.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Energy/glow colour; falls back to the accent when no variable is in scope. */
const ACCENT = "var(--icon-accent, #ffb648)";

type Attrs = Record<string, string | number>;

interface Pen {
  path(d: string, attrs?: Attrs): void;
  circle(cx: number, cy: number, r: number, attrs?: Attrs): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, attrs?: Attrs): void;
  rect(x: number, y: number, w: number, h: number, attrs?: Attrs): void;
}

type Glyph = (p: Pen) => void;

const STROKE: Attrs = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.3,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** A soft three-stop glow built from concentric translucent discs. */
function glow(p: Pen, cx: number, cy: number, r: number, alpha = 1): void {
  p.circle(cx, cy, r * 2, { fill: "currentColor", fillOpacity: 0.08 * alpha, stroke: "none" });
  p.circle(cx, cy, r * 1.35, { fill: "currentColor", fillOpacity: 0.18 * alpha, stroke: "none" });
  p.circle(cx, cy, r * 0.8, { fill: "currentColor", fillOpacity: 0.45 * alpha, stroke: "none" });
  p.circle(cx, cy, r * 0.34, { fill: ACCENT, fillOpacity: 0.85 * alpha, stroke: "none" });
}

function solid(p: Pen, cx: number, cy: number, r: number, opacity = 0.85): void {
  p.circle(cx, cy, r, { fill: "currentColor", fillOpacity: opacity, stroke: "none" });
}

/** The marine-line helmet: dome, visor slit, jaw. Shared by four units. */
function helmet(p: Pen): void {
  p.path("M7.5 14a4.5 4.5 0 0 1 9 0v2.5h-9z", { fill: "currentColor", fillOpacity: 0.16 });
  p.path("M8.4 11.2h7.2v1.9H8.4z", { fill: "currentColor", fillOpacity: 0.75, stroke: "none" });
  p.path("M9.6 14.3h4.8v3.2H9.6z", { fill: "currentColor", fillOpacity: 0.28 });
  p.path("M4.9 20.5c1.1-2.3 2.9-3.5 4.5-3.9M19.1 20.5c-1.1-2.3-2.9-3.5-4.5-3.9");
}

function eyes(p: Pen, left: number, right: number, cy: number, r = 0.8): void {
  solid(p, left, cy, r, 0.9);
  solid(p, right, cy, r, 0.9);
}

/* ------------------------------------------------------------------ */
/* Unit glyphs                                                         */
/* ------------------------------------------------------------------ */

const UNIT_GLYPHS: Record<string, Glyph> = {
  /* Terran */
  marine: (p) => helmet(p),

  firebat: (p) => {
    helmet(p);
    p.rect(4.4, 11.6, 2.2, 2.9, { rx: 0.8, fill: "currentColor", fillOpacity: 0.3 });
    p.rect(17.4, 11.6, 2.2, 2.9, { rx: 0.8, fill: "currentColor", fillOpacity: 0.3 });
    p.path("M5.5 15.2c-.7 1.5-.4 2.8.5 3.6M18.5 15.2c.7 1.5.4 2.8-.5 3.6", { stroke: ACCENT });
  },

  ghost: (p) => {
    p.path(
      "M6.5 20.6c-.6-4 .3-8 2.4-10.6 1.5-1.9 4.7-1.9 6.2.6 1.4 2.3 1.4 5.4.7 7.4l-1.6-1.4-1.4 1.7-1.7-1.7-1.6 1.6-1.5-1.6-1.5 1.6z",
      { fill: "currentColor", fillOpacity: 0.16 },
    );
    eyes(p, 10.3, 13.7, 12.4, 0.9);
  },

  medic: (p) => {
    helmet(p);
    p.path("M12 15.2v3.6M10.2 17h3.6", { stroke: ACCENT, "stroke-width": 1.5 });
  },

  scv: (p) => {
    p.path("M8 6.4h8l1 4.8H7z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M8.8 8.4h6.4");
    solid(p, 12, 9.8, 1, 0.85);
    p.rect(5.6, 13.4, 12.8, 3.2, { rx: 1.1, fill: "currentColor", fillOpacity: 0.22 });
    p.path("M8 14.6v1.8M11 14.6v1.8M14 14.6v1.8", { opacity: 0.7 });
    p.path("M4.5 19.4h15");
  },

  reaper: (p) => {
    p.path("M10.2 6.4h3.6l.9 4.6-2.7 2.5-2.7-2.5z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M10.8 8.6h2.4");
    p.circle(6.4, 15.4, 3.2, { fill: "currentColor", fillOpacity: 0.16 });
    p.circle(6.4, 15.4, 1.1);
    p.path("M17.6 12.4 16 15.4l1.6 3 1.6-3z", { fill: "currentColor", fillOpacity: 0.3 });
    p.path("M9.5 19.4h5");
  },

  siege_tank: (p) => {
    p.path("M4 16.4h16v3.2H4z", { rx: 1, fill: "currentColor", fillOpacity: 0.22 });
    p.path("M6.2 17.4v1.2M9.4 17.4v1.2M12 17.4v1.2M14.6 17.4v1.2M17.8 17.4v1.2", { opacity: 0.6 });
    p.path("M8 12.6a4 4 0 0 1 8 0z", { fill: "currentColor", fillOpacity: 0.28 });
    p.path("M11.4 11.4 20 8.4", { "stroke-width": 1.8 });
    glow(p, 20, 8.3, 0.7, 0.8);
  },

  thor: (p) => {
    p.path("M9 4.8h6l1.5 5.6L12 13.6 7.5 10.4z", { fill: "currentColor", fillOpacity: 0.2 });
    glow(p, 12, 10.2, 1.2, 0.9);
    p.path("M3.6 8.2 7 10.4M20.4 8.2 17 10.4", { "stroke-width": 1.6 });
    p.path("M9.4 13.8 7.6 20.6M14.6 13.8 16.4 20.6");
  },

  raven: (p) => {
    p.path("M12 6 14.6 9.4 12 12.8 9.4 9.4z", { fill: "currentColor", fillOpacity: 0.24 });
    p.path("M9.4 9.4 2.8 12.2l3.6 1M14.6 9.4 21.2 12.2l-3.6 1");
    p.rect(4.4, 11, 3, 4.2, { rx: 1, fill: "currentColor", fillOpacity: 0.26 });
    p.rect(16.6, 11, 3, 4.2, { rx: 1, fill: "currentColor", fillOpacity: 0.26 });
    glow(p, 5.9, 15.8, 0.6, 0.7);
    glow(p, 18.1, 15.8, 0.6, 0.7);
  },

  battlecruiser: (p) => {
    p.path("M2.4 10.4 9 7.2h6l6.6 3.2-1.6 3.6H4z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M12 7.2v6.8M6.4 12.6h3M14.6 12.6h3", { opacity: 0.8 });
    p.path("M7 14v3.2M17 14v3.2");
    glow(p, 12, 18.2, 1.6, 0.9);
  },

  /* Protoss */
  probe: (p) => {
    p.path("M8 8.6h8l1.6 3.6L16 15.8H8L6.4 12.2z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M9 10.6h6", { opacity: 0.8 });
    p.path("M8 15.8 6.2 19.4M16 15.8l1.8 3.6");
    glow(p, 12, 19, 1.3, 0.5);
  },

  zealot: (p) => {
    p.path("M9 6.6 12 4l3 2.6v4.6L12 13.8 9 11.2z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M9.8 9.2h4.4", { "stroke-width": 1.6 });
    p.path("M3.6 20.6 8.4 11.2M20.4 20.6 15.6 11.2", { "stroke-width": 1.7 });
    p.path("M5 19.4h5.2M13.8 19.4H19");
  },

  stalker: (p) => {
    p.path("M10 5.4h4l1.5 5-3.5 3-3.5-3z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M10.4 8.6h3.2", { "stroke-width": 1.6 });
    p.path("M9.6 13.4 5.2 12M14.4 13.4 18.8 12");
    p.circle(5.6, 15, 1.7, { fill: "currentColor", fillOpacity: 0.26 });
    p.circle(18.4, 15, 1.7, { fill: "currentColor", fillOpacity: 0.26 });
    glow(p, 5.6, 15, 0.5, 0.8);
    glow(p, 18.4, 15, 0.5, 0.8);
  },

  sentry: (p) => {
    p.path("M12 4.4 18 9l-2.5 7.2h-7L6 9z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M12 4.4V2.6M6 9H4M18 9h2", { opacity: 0.7 });
    solid(p, 12, 12, 1.6, 0.9);
    glow(p, 12, 12, 2.4, 0.8);
    p.path("M4.4 20.4 8 17.4M19.6 20.4 16 17.4");
  },

  high_templar: (p) => {
    p.path("M9.4 6.4h5.2l1 5-2.1 3.2h-3L8.4 11.4z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M10.4 9.4h3.2", { "stroke-width": 1.5 });
    p.path("M6.8 4.6 3.8 9M17.2 4.6 20.2 9M6 13.4 3.4 15.6M18 13.4l2.6 2.2", { stroke: ACCENT });
  },

  dark_templar: (p) => {
    p.path("M7.6 20.6c-.4-6.2 1.2-11.2 4.4-13.6 3.2 2.4 4.8 7.4 4.4 13.6", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M9.8 11.8h4.4", { "stroke-width": 1.6 });
    p.path("M18.4 5.4 12.6 20.6", { "stroke-width": 1.7, stroke: ACCENT });
  },

  adept: (p) => {
    p.path("M17.4 4.2c2.2 4 1.7 9.2-1.8 12.8", { "stroke-width": 1.7 });
    p.path("M17.4 4.2c-4.4.6-8.4 3.6-10 8.4");
    p.path("M3.6 20.6 8 16.4");
    glow(p, 18.2, 6.2, 1.3, 0.9);
    p.path("M3 19.4h6.4");
  },

  archon: (p) => {
    p.path("M12 4.4 15.4 8v4.4H8.6V8z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M9.8 9h4.4", { "stroke-width": 1.6 });
    p.path("M8.6 12.4 6 15.2M15.4 12.4l2.6 2.8");
    glow(p, 5.4, 17, 2, 0.9);
    glow(p, 18.6, 17, 2, 0.9);
    p.path("M8.4 20.6 10 17.6M15.6 20.6 14 17.6");
  },

  carrier: (p) => {
    p.path("M2.4 9.4 8 6.2h8l5.6 3.2-2 4.2H4.4z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M6.4 11.4h3M14.6 11.4h3M4 13.6h16", { opacity: 0.8 });
    glow(p, 7, 17, 1, 0.6);
    glow(p, 12, 17, 1, 0.6);
    glow(p, 17, 17, 1, 0.6);
  },

  phoenix: (p) => {
    p.path("M12 5.6 15.2 9.2 12 13.2 8.8 9.2z", { fill: "currentColor", fillOpacity: 0.24 });
    p.path("M9.4 10 2.6 8.2 6.4 14.4M14.6 10l6.8-1.8-3.8 6.2");
    p.path("M12 13.4 9.4 18.6M12 13.4l2.6 5.2");
    glow(p, 12, 19.6, 1.5, 0.8);
  },

  /* Zerg */
  drone: (p) => {
    p.path("M7 15c0-3 2.2-5.2 5-5.2s5 2.2 5 5.2c0 1.6-1.4 2.6-3 2.6h-4c-1.6 0-3-1-3-2.6z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M7.4 14.4C4.8 13.2 3.4 10.8 4 8.2M16.6 14.4c2.6-1.2 4-3.6 3.4-6.2");
    eyes(p, 9.8, 14.2, 12.4, 0.75);
    p.path("M9 18.6h6", { opacity: 0.7 });
  },

  zergling: (p) => {
    p.path("M5.8 15.8c0-2.6 2.2-4.6 5.2-4.6s5.2 2 5.2 4.6c0 1.3-1.1 2.1-2.2 2.1H8c-1.1 0-2.2-.8-2.2-2.1z", { fill: "currentColor", fillOpacity: 0.24 });
    p.path("M5.8 14.6 3.2 11.4M18.2 14.6l2.6-3.2");
    p.path("M3.6 10.8 4.6 8.2M20.4 10.8 19.4 8.2");
    eyes(p, 9.4, 14.6, 13.6, 0.7);
    p.path("M8 19.6 7 21.6M12 19.6v2M16 19.6l1 2");
  },

  hydralisk: (p) => {
    p.path("M8 16c0-3.4 1.8-6 4-6s4 2.6 4 6c0 1.4-1 2.2-2 2.2h-4c-1 0-2-.8-2-2.2z", { fill: "currentColor", fillOpacity: 0.24 });
    p.path("M8.6 11.4 5.2 9M15.4 11.4 18.8 9M7.6 14.2 3.8 13.6M16.4 14.2l3.8-.6", { "stroke-width": 1.5 });
    eyes(p, 10.6, 13.4, 12.8, 0.8);
    p.path("M9 18.6h6", { opacity: 0.7 });
  },

  ultralisk: (p) => {
    p.path("M5.4 16.4c0-3.6 2.9-6.2 6.6-6.2s6.6 2.6 6.6 6.2c0 1.6-1.4 2.6-3 2.6h-7.2c-1.6 0-3-1-3-2.6z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M2.8 8.6c4.2 1 6.4 3.2 7.6 5.4M21.2 8.6c-4.2 1-6.4 3.2-7.6 5.4", { "stroke-width": 1.5 });
    eyes(p, 9.4, 14.6, 13.4, 0.9);
    p.path("M8 19.6v2.4M12 19.6v2.4M16 19.6v2.4", { opacity: 0.7 });
  },

  queen: (p) => {
    p.path("M12 5.6c2.1 2.2 3.1 4.6 3.1 7.2 0 2.2-1.3 3.6-3.1 3.6s-3.1-1.4-3.1-3.6c0-2.6 1-5 3.1-7.2z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M12 5.6 9.8 2.6M12 5.6l2.2-3", { "stroke-width": 1.5 });
    solid(p, 12, 10.6, 0.9, 0.9);
    p.path("M9.4 15.2 7 20.6M14.6 15.2 17 20.6", { "stroke-width": 1.4 });
  },

  roach: (p) => {
    p.path("M4.4 16.2c0-3 2.6-5 7.6-5s7.6 2 7.6 5-2.6 4.2-7.6 4.2-7.6-1.2-7.6-4.2z", { fill: "currentColor", fillOpacity: 0.24 });
    p.path("M7 12 3.8 9.4M17 12l3.2-2.6", { "stroke-width": 1.5 });
    eyes(p, 9.4, 14.6, 15, 0.7);
    p.path("M6 19.4h12", { opacity: 0.7 });
  },

  lurker: (p) => {
    p.path("M3.4 19.4c0-4.4 3.8-7.6 8.6-7.6s8.6 3.2 8.6 7.6z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M5.4 13 3.2 8.8M9.4 11.8 8.2 7M12 11.2V6.2M14.6 11.8l1.2-4.8M18.6 13l2.2-4.2", { "stroke-width": 1.5 });
    p.path("M8 16.6h8", { stroke: ACCENT, "stroke-width": 1.5 });
  },

  infestor: (p) => {
    p.path("M12 6.2c3.6 0 6 2.6 6 5.7 0 2.6-2 4.5-4.7 4.5h-2.6C8 16.4 6 14.5 6 11.9c0-3.1 2.4-5.7 6-5.7z", { fill: "currentColor", fillOpacity: 0.22 });
    p.path("M9 16.4c-1.2 2-.8 3.6.6 5M12 16.4v4.6M15 16.4c1.2 2 .8 3.6-.6 5", { "stroke-width": 1.4 });
    eyes(p, 10, 14, 11.4, 0.8);
  },

  corruptor: (p) => {
    p.path("M12 5.6c4.4 0 7.6 2 7.6 4.6S16.4 14.8 12 14.8s-7.6-2-7.6-4.6 3.2-4.6 7.6-4.6z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M8.4 14.4c-.6 2.6 0 4.6 1.6 6.2M12 14.8v5.4M15.6 14.4c.6 2.6 0 4.6-1.6 6.2", { "stroke-width": 1.4 });
    glow(p, 12, 10.2, 1.5, 0.8);
  },

  guardian: (p) => {
    p.path("M3 11.6c0-1.4 4-2.6 9-2.6s9 1.2 9 2.6-4 2.6-9 2.6-9-1.2-9-2.6z", { fill: "currentColor", fillOpacity: 0.2 });
    solid(p, 12, 11.6, 1.5, 0.85);
    p.path("M9.2 14.8 8.2 19.6M14.8 14.8l1 4.8", { stroke: ACCENT, "stroke-width": 1.5 });
    glow(p, 12, 19.6, 1.4, 0.55);
  },
};

/* ------------------------------------------------------------------ */
/* Building glyphs                                                     */
/* ------------------------------------------------------------------ */

const BUILDING_GLYPHS: Record<string, Glyph> = {
  /* Terran */
  command_center: (p) => {
    p.rect(4, 10.4, 16, 6.6, { rx: 1.4, fill: "currentColor", fillOpacity: 0.14 });
    p.path("M4.4 10.4 8.2 6.6h7.6l3.8 3.8");
    p.path("M9 13.4h6M9 15.2h4", { opacity: 0.85 });
    p.path("M17 10.4V5M14.4 6.6h5.2", { "stroke-width": 1.4 });
    p.path("M3 19.6h18", { opacity: 0.6 });
  },

  supply_depot: (p) => {
    p.rect(6, 7.6, 12, 7.2, { rx: 1.2, fill: "currentColor", fillOpacity: 0.16 });
    p.path("M6 11h12", { opacity: 0.85 });
    p.path("M8.2 14.8v4.4M12 14.8v4.8M15.8 14.8v4.4");
    p.path("M5 19.6h14", { opacity: 0.6 });
  },

  refinery: (p) => {
    p.rect(4, 12, 16, 5.2, { rx: 1, fill: "currentColor", fillOpacity: 0.14 });
    p.path("M6.4 12a2.9 2.9 0 0 1 5.8 0M11.8 12a2.9 2.9 0 0 1 5.8 0", { opacity: 0.9 });
    p.path("M18.4 12V6.4h3.2", { "stroke-width": 1.5 });
    p.path("M2.6 19.6h18.8", { opacity: 0.6 });
  },

  barracks: (p) => {
    p.path("M3 18.6V9l3-3.6h12l3 3.6v9.6z", { fill: "currentColor", fillOpacity: 0.14 });
    p.path("M9.4 18.6v-5.2h5.2v5.2", { opacity: 0.9 });
    p.path("M6 9.6h3M15 9.6h3", { opacity: 0.8 });
  },

  engineering_bay: (p) => {
    p.rect(4, 11.2, 16, 7.4, { rx: 1.2, fill: "currentColor", fillOpacity: 0.14 });
    p.path("M9 11.2a3 3 0 0 1 6 0");
    glow(p, 12, 9.4, 1.1, 0.7);
    p.path("M7 15h4M13 15h4", { opacity: 0.85 });
  },

  factory: (p) => {
    p.path("M3 18.6v-6.4l4-3.4v3.4l4-3.4v3.4l4-3.4v9.8z", { fill: "currentColor", fillOpacity: 0.14 });
    p.rect(3, 16.2, 18, 2.4, { rx: 0.8, fill: "currentColor", fillOpacity: 0.24 });
    p.circle(8, 11.4, 1.2, { fill: "currentColor", fillOpacity: 0.45, stroke: "none" });
    p.circle(13, 11.4, 1.2, { fill: "currentColor", fillOpacity: 0.45, stroke: "none" });
  },

  starport: (p) => {
    p.path("M8 19.6 9 7.4h6l1 12.2z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M5.6 19.6 8.8 12.4M18.4 19.6 15.2 12.4", { "stroke-width": 1.4 });
    p.path("M9.4 10.4h5.2", { opacity: 0.85 });
    glow(p, 12, 6, 1.2, 0.8);
  },

  bunker: (p) => {
    p.path("M3 19.4v-4.6C3 11 7 8.4 12 8.4s9 2.6 9 6.4v4.6z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M6.4 14.4h11.2", { stroke: ACCENT, "stroke-width": 1.5 });
    p.path("M5 19.4h14", { opacity: 0.6 });
  },

  turret: (p) => {
    p.path("M5.6 19.6 8 14.6h8l2.4 5z", { fill: "currentColor", fillOpacity: 0.16 });
    p.rect(9, 8.6, 6, 6, { rx: 1, fill: "currentColor", fillOpacity: 0.2 });
    p.path("M9.6 10.2 4.4 7.8M14.4 10.2l5.2-2.4", { "stroke-width": 1.6 });
    p.path("M9 12.6h6", { opacity: 0.85 });
  },

  /* Protoss */
  nexus: (p) => {
    p.path("M12 4.8 19 9.4l-2.5 8.2h-9L5 9.4z", { fill: "currentColor", fillOpacity: 0.14 });
    p.path("M12 4.8 19 9.4l-2.5 8.2h-9L5 9.4z", { "stroke-dasharray": "2.4 1.8", opacity: 0.7 });
    glow(p, 12, 11.6, 2.2, 0.95);
    p.path("M8.2 20.4 12 18l3.8 2.4");
  },

  pylon: (p) => {
    p.path("M9.4 20.6 10.8 8.6h2.4l1.4 12z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M8.8 12.4h6.4M9.2 16.4h5.6", { opacity: 0.85 });
    p.path("M10.6 8.6 12 5.2l1.4 3.4", { stroke: ACCENT, "stroke-width": 1.5 });
    glow(p, 12, 4.6, 2, 1.05);
  },

  assimilator: (p) => {
    p.path("M7 15.4a5 5 0 0 1 10 0z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M8.2 15.4 5.2 20M15.8 15.4 18.8 20M12 15.4v5");
    glow(p, 12, 12.6, 1.5, 0.8);
    p.path("M5.4 20.4h13.2", { opacity: 0.6 });
  },

  gateway: (p) => {
    p.path("M12 3.2 18.4 5.8v12.4L12 20.8 5.6 18.2V5.8z", { fill: "currentColor", fillOpacity: 0.12 });
    p.path("M12 6.4 15.6 8v8L12 17.6 8.4 16V8z", { fill: "currentColor", fillOpacity: 0.2 });
    glow(p, 12, 12, 1.8, 0.85);
  },

  forge: (p) => {
    p.path("M4 19.6v-6.2l8-3.6 8 3.6v6.2z", { fill: "currentColor", fillOpacity: 0.14 });
    p.path("M15 9.8V4.8h3.2v7", { "stroke-width": 1.5 });
    p.path("M7 15.4h4M13 15.4h4", { opacity: 0.85 });
    p.path("M4 15.6 12 19.2l8-3.6", { opacity: 0.7 });
  },

  photon_cannon: (p) => {
    p.path("M6 19.6 8 15h8l2 4.6z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M11 15V9.4h2V15");
    p.path("M9.4 9.4 19 5.4", { "stroke-width": 1.8, stroke: ACCENT });
    glow(p, 19.4, 5.2, 1.5, 0.9);
    p.path("M8 17.4h8", { opacity: 0.7 });
  },

  cybernetics_core: (p) => {
    p.circle(12, 12.4, 6.4, { fill: "currentColor", fillOpacity: 0.12 });
    p.circle(12, 12.4, 3.1, { fill: "currentColor", fillOpacity: 0.55, stroke: "none" });
    p.path("M12 4.4v1.8M12 18.6v1.8M3.6 12.4h1.8M18.6 12.4h1.8", { opacity: 0.8 });
  },

  twilight_council: (p) => {
    p.path("M4.6 20.4 6.4 7h4.2l1.8 13.4z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M11.6 20.4 13.4 9.6h4.2l1.8 10.8z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M8.4 12.4h5.4", { opacity: 0.85 });
    glow(p, 8.5, 5.6, 1.2, 0.75);
    glow(p, 15.5, 8.2, 1.2, 0.75);
  },

  robotics_facility: (p) => {
    p.path("M4 19.6v-4.2C4 11 7.6 7.8 12 7.8s8 3.2 8 7.6v4.2z", { fill: "currentColor", fillOpacity: 0.14 });
    p.path("M7.8 12.8 12 10l4.2 2.8");
    solid(p, 12, 9.8, 0.9, 0.85);
    p.path("M5.4 16.6h13.2", { opacity: 0.8 });
  },

  /* Zerg */
  hatchery: (p) => {
    p.path("M3 19.6C3 12 7 7.4 12 7.4s9 4.6 9 12.2z", { fill: "currentColor", fillOpacity: 0.18 });
    p.circle(8, 12.4, 1.5, { fill: "currentColor", fillOpacity: 0.4, stroke: "none" });
    p.circle(13, 10.4, 1.8, { fill: "currentColor", fillOpacity: 0.4, stroke: "none" });
    p.circle(16.8, 13.2, 1.3, { fill: "currentColor", fillOpacity: 0.4, stroke: "none" });
    p.path("M6 19.6h12", { opacity: 0.6 });
  },

  overlord: (p) => {
    p.path("M12 5.2c4 0 6.6 2.9 6.6 6.4S16 18 12 18s-6.6-2.9-6.6-6.4S8 5.2 12 5.2z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M8.4 17.4c-.6 2.6 0 4 1.6 5M12 18v4.4M15.6 17.4c.6 2.6 0 4-1.6 5", { "stroke-width": 1.4 });
    eyes(p, 9.6, 14.4, 10.2, 0.85);
  },

  extractor: (p) => {
    p.path("M6 19.6 9 11.2h6l3 8.4z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M9 11.2a3 3 0 0 1 6 0");
    p.path("M12 8.2V4.4");
    glow(p, 12, 3.8, 1.3, 0.8);
    p.path("M5 19.6h14", { opacity: 0.6 });
  },

  spawning_pool: (p) => {
    p.path("M3.4 19.6 6 12.2h12l2.6 7.4z", { fill: "currentColor", fillOpacity: 0.14 });
    p.path("M6 12.2c1.6-2.6 4-3.6 6-3.6s4.4 1 6 3.6");
    p.path("M8 16.6h8", { opacity: 0.85 });
    solid(p, 12, 15, 0.9, 0.5);
  },

  hydralisk_den: (p) => {
    p.path("M4 19.6c0-7 3.6-11.6 8-11.6s8 4.6 8 11.6z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M7 12 5 7M9.6 12.4 9 7.8M12 10.6V5.4M14.4 12.4 15 7.8M17 12l2-5", { "stroke-width": 1.5 });
    p.path("M8 16.6h8", { opacity: 0.8 });
  },

  roach_warren: (p) => {
    p.path("M3.8 19.6 5.4 10.2h5L11 19.6z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M13 19.6 14.6 8.6h5L18.2 19.6z", { fill: "currentColor", fillOpacity: 0.18 });
    p.circle(7.9, 12.2, 1.2, { fill: "currentColor", fillOpacity: 0.4, stroke: "none" });
    p.circle(17.1, 10.6, 1.2, { fill: "currentColor", fillOpacity: 0.4, stroke: "none" });
    p.path("M3 19.6h18", { opacity: 0.6 });
  },

  spire: (p) => {
    p.path("M8 20.6 9.6 6.6 12 3.8l2.4 2.8L16 20.6z", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M9 11.6h6M8.6 16.2h6.8", { opacity: 0.85 });
    glow(p, 12, 4.6, 1.5, 0.85);
    p.path("M6 20.6h12", { opacity: 0.6 });
  },

  lair: (p) => {
    p.path("M3 19.6c0-8 4-12.2 9-12.2s9 4.2 9 12.2z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M7.8 8.8 9.4 4.2 11 8.8M13 8.8l1.4-4.6L16 8.8", { "stroke-width": 1.5 });
    p.path("M7 15.6h10", { opacity: 0.85 });
  },

  spine_crawler: (p) => {
    p.rect(3.4, 17.2, 17.2, 2.6, { rx: 1.2, fill: "currentColor", fillOpacity: 0.2 });
    p.path("M7 17.2v-4.2h10v4.2", { fill: "currentColor", fillOpacity: 0.16 });
    p.path("M8.4 12.8 6.8 9.4M12 12.4V8M15.6 12.8l1.6-3.4", { "stroke-width": 1.5 });
    solid(p, 12, 10.4, 0.9, 0.6);
  },
};

/** Shown for any key the roster does not have a glyph for. */
const FALLBACK_GLYPH: Glyph = (p) => {
  p.path("M12 3.4 19.6 8v8L12 20.6 4.4 16V8z", { "stroke-dasharray": "3 2.4", opacity: 0.8 });
  p.path("M10 9.4a2.1 2.1 0 0 1 3.8 1.2c0 1.7-1.9 1.9-1.9 3.2");
  solid(p, 11.9, 16.4, 0.9, 0.8);
};

/* ------------------------------------------------------------------ */
/* Resource glyphs used by the HUD chips                               */
/* ------------------------------------------------------------------ */

const RESOURCE_GLYPHS: Record<string, Glyph> = {
  minerals: (p) => {
    p.path("M12 3.6 19 9.2 16.4 17H7.6L5 9.2z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M12 3.6 9 9.2l3 7.8M12 3.6l3 5.6", { opacity: 0.75 });
  },
  vespene: (p) => {
    p.path("M6.4 19.6 9 5.4h6l2.6 14.2z", { fill: "currentColor", fillOpacity: 0.2 });
    p.path("M10 5.4 12 2.6l2 2.8", { stroke: ACCENT, "stroke-width": 1.5 });
  },
  supply: (p) => {
    p.path("M6 8.6 12 4.6l6 4v7.8l-6 4-6-4z", { fill: "currentColor", fillOpacity: 0.18 });
    p.path("M12 4.6v15.8M6 8.6l6 4 6-4", { opacity: 0.7 });
  },
};

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

let injectedDoc: Document | null = null;
const cache = new Map<string, SVGSVGElement>();


/**
 * Supplies a document for headless environments. Pass `null` to go back to
 * resolving the global one. Must be called before the first icon is built.
 */
export function setIconDocument(doc: Document | null): void {
  if (doc !== injectedDoc) clearIconCache();
  injectedDoc = doc;
}

export function clearIconCache(): void {
  cache.clear();
}

/** How many `key:size` templates are currently cached. */
export function iconCacheSize(): number {
  return cache.size;
}

function resolveDocument(): Document {
  const doc = injectedDoc ?? (typeof document === "undefined" ? null : document);
  if (doc === null) {
    throw new Error("icons: no document available — call setIconDocument(doc) in a headless environment");
  }
  return doc;
}

function makePen(doc: Document, group: SVGGElement): Pen {
  const add = (tag: string, attrs: Attrs): SVGElement => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    group.append(node);
    return node;
  };
  return {
    path: (d, attrs) => {
      add("path", { ...STROKE, ...attrs, d });
    },
    circle: (cx, cy, r, attrs) => {
      add("circle", { ...STROKE, ...attrs, cx, cy, r });
    },
    ellipse: (cx, cy, rx, ry, attrs) => {
      add("ellipse", { ...STROKE, ...attrs, cx, cy, rx, ry });
    },
    rect: (x, y, w, h, attrs) => {
      add("rect", { ...STROKE, ...attrs, x, y, width: w, height: h, rx: attrs?.rx ?? 0 });
    },
  };
}

function build(doc: Document, glyph: Glyph, size: number): SVGSVGElement {
  const root = doc.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", "0 0 24 24");
  root.setAttribute("width", String(size));
  root.setAttribute("height", String(size));
  root.setAttribute("class", "icon");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  const group = doc.createElementNS(SVG_NS, "g");
  root.append(group);
  glyph(makePen(doc, group));
  return root;
}

function icon(key: string, table: Record<string, Glyph>, size: number, isBuilding: boolean): SVGSVGElement {
  const extent = Number.isFinite(size) && size > 0 ? Math.round(size) : 24;
  const cacheKey = `${isBuilding ? "b" : "u"}:${key}:${extent}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.cloneNode(true) as SVGSVGElement;
  const doc = resolveDocument();
  const glyph = table[key] ?? FALLBACK_GLYPH;
  const template = build(doc, glyph, extent);
  cache.set(cacheKey, template);
  return template.cloneNode(true) as SVGSVGElement;
}

/** Glyph for a unit key, or the unknown-key fallback. */
export function unitIcon(key: string, size: number): SVGSVGElement {
  return icon(key, UNIT_GLYPHS, size, false);
}

/** Glyph for a building key, or the unknown-key fallback. */
export function buildingIcon(key: string, size: number): SVGSVGElement {
  return icon(key, BUILDING_GLYPHS, size, true);
}

/** True when a purpose-built glyph exists for this key. */
export function hasIcon(key: string, isBuilding: boolean): boolean {
  return (isBuilding ? BUILDING_GLYPHS : UNIT_GLYPHS)[key] !== undefined;
}

/**
 * Glyph for any roster key: the unit/building set is picked from the data, so
 * callers holding only an entity key never have to know its kind. Unknown keys
 * get the fallback glyph.
 */
export function entityIcon(key: string, size: number): SVGSVGElement {
  return BUILDING_GLYPHS[key] === undefined ? unitIcon(key, size) : buildingIcon(key, size);
}

/** Small HUD glyph for a resource readout. */
export function resourceIcon(kind: "minerals" | "vespene" | "supply", size: number): SVGSVGElement {
  const extent = Number.isFinite(size) && size > 0 ? Math.round(size) : 16;
  const cacheKey = `r:${kind}:${extent}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.cloneNode(true) as SVGSVGElement;
  const doc = resolveDocument();
  const template = build(doc, RESOURCE_GLYPHS[kind], extent);
  cache.set(cacheKey, template);
  return template.cloneNode(true) as SVGSVGElement;
}

/**
 * The wordmark emblem: a hexagonal command badge with a forward chevron and a
 * scanline. Drawn, not loaded.
 */
export function brandMark(size: number): SVGSVGElement {
  const extent = Number.isFinite(size) && size > 0 ? Math.round(size) : 56;
  const cacheKey = `brand:${extent}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.cloneNode(true) as SVGSVGElement;
  const doc = resolveDocument();
  const root = doc.createElementNS(SVG_NS, "svg");
  root.setAttribute("viewBox", "0 0 48 48");
  root.setAttribute("width", String(extent));
  root.setAttribute("height", String(extent));
  root.setAttribute("class", "icon icon--brand");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  const group = doc.createElementNS(SVG_NS, "g");
  root.append(group);
  const pen = makePen(doc, group);
  pen.path("M24 3 42 13.5v21L24 45 6 34.5v-21z", { fill: "currentColor", fillOpacity: 0.08 });
  pen.path("M24 3 42 13.5v21L24 45 6 34.5v-21z", { "stroke-width": 1.6 });
  pen.path("M17 15.5 25.5 24 17 32.5M27 15.5 35.5 24 27 32.5", { "stroke-width": 2, stroke: ACCENT });
  pen.path("M12 38.5h24", { opacity: 0.5 });
  cache.set(cacheKey, root);
  return root.cloneNode(true) as SVGSVGElement;
}
