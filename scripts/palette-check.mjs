// Palette validator for the drivechain series colours in lib/config.ts.
//
//   node scripts/palette-check.mjs            # adjacent pairs (stack order)
//   node scripts/palette-check.mjs --pairs all
//
// lib/config.ts's comment tells you to re-run this before editing a colour, so
// it has to exist. No dependencies: OKLab conversion, ΔE, dichromat simulation
// and WCAG contrast are all a few lines of arithmetic.
//
// ΔE is Euclidean distance in OKLab × 100. Dichromat simulation is Viénot 1999
// in linear sRGB. Contrast is WCAG 2.x against the page background.
//
// The thresholds below are the set's own measured baseline, not an external
// standard — the point is to notice a REGRESSION when someone edits a colour.

import { readFileSync } from "node:fs";

const BG = "#0a0a0a";            // page background (bg-neutral-950)
const ADJ_NORMAL_FLOOR = 15;     // design goal for on-screen neighbours
const ADJ_CVD_FLOOR = 8.4;       // measured baseline before Flush was added
const CONTRAST_FLOOR = 3.0;

const hex2rgb = (h) => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab([r8, g8, b8]) {
  const [r, g, b] = [r8, g8, b8].map(s2l);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const dE = (a, b) => {
  const [x, y, z] = oklab(a);
  const [u, v, w] = oklab(b);
  return 100 * Math.hypot(x - u, y - v, z - w);
};
function cvd(rgb, kind) {
  const [r, g, b] = rgb.map(s2l);
  let L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  let M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  const S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;
  if (kind === "deutan") M = 0.494207 * L + 1.24827 * S;
  else L = 2.02344 * M - 2.52581 * S;
  return [
    0.080944 * L - 0.130504 * M + 0.116721 * S,
    -0.0102485 * L + 0.0540194 * M - 0.113615 * S,
    -0.000365294 * L - 0.00412163 * M + 0.693513 * S,
  ].map(l2s);
}
const relL = (rgb) => {
  const [r, g, b] = rgb.map(s2l);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [relL(a) + 0.05, relL(b) + 0.05];
  return Math.max(x, y) / Math.min(x, y);
};

// Parse the registry straight out of config.ts so the two cannot drift apart.
const src = readFileSync(new URL("../lib/config.ts", import.meta.url), "utf8");
const chains = [
  ...src.matchAll(
    /slot:\s*(\d+),\s*\n\s*name:\s*"([^"]+)",[\s\S]*?color:\s*"(#[0-9a-fA-F]{6})"/g,
  ),
].map(([, slot, name, color]) => ({ slot: +slot, name, color }));

if (chains.length === 0) {
  console.error("could not parse any chains out of lib/config.ts");
  process.exit(2);
}
// Colours are assigned in ascending slot order, and the chart stacks in that
// same order, so these are the pairs that actually touch on screen.
chains.sort((a, b) => a.slot - b.slot);

const allPairs = process.argv.includes("all") || process.argv.includes("--pairs=all");
const pairs = [];
if (allPairs) {
  for (let i = 0; i < chains.length; i++)
    for (let j = i + 1; j < chains.length; j++) pairs.push([chains[i], chains[j]]);
} else {
  for (let i = 0; i < chains.length - 1; i++) pairs.push([chains[i], chains[i + 1]]);
}

let failed = false;
console.log(`${chains.length} chains · ${allPairs ? "ALL pairs" : "adjacent pairs"}\n`);
for (const c of chains) {
  const k = contrast(hex2rgb(c.color), hex2rgb(BG));
  const bad = k < CONTRAST_FLOOR;
  if (bad) failed = true;
  console.log(
    `  ${bad ? "FAIL" : "ok  "} slot ${String(c.slot).padStart(3)} ${c.name.padEnd(10)} ${c.color}  contrast ${k.toFixed(2)}:1`,
  );
}
console.log();
const rows = pairs.map(([a, b]) => {
  const [ra, rb] = [hex2rgb(a.color), hex2rgb(b.color)];
  return {
    pair: `${a.name}/${b.name}`,
    normal: dE(ra, rb),
    deutan: dE(cvd(ra, "deutan"), cvd(rb, "deutan")),
    protan: dE(cvd(ra, "protan"), cvd(rb, "protan")),
  };
});
rows.sort((x, y) => Math.min(x.deutan, x.protan) - Math.min(y.deutan, y.protan));
for (const r of rows) {
  const cvdWorst = Math.min(r.deutan, r.protan);
  // All-pairs CVD is known to be unachievable for a set this size, so only the
  // adjacent run is gated. See the KNOWN LIMIT note in lib/config.ts.
  const bad = !allPairs && (cvdWorst < ADJ_CVD_FLOOR || r.normal < ADJ_NORMAL_FLOOR);
  if (bad) failed = true;
  console.log(
    `  ${bad ? "FAIL" : "ok  "} ${r.pair.padEnd(22)} normal ${r.normal.toFixed(1).padStart(5)}  deutan ${r.deutan.toFixed(1).padStart(5)}  protan ${r.protan.toFixed(1).padStart(5)}`,
  );
}
console.log(
  `\nworst: normal ${Math.min(...rows.map((r) => r.normal)).toFixed(1)}, ` +
    `CVD ${Math.min(...rows.map((r) => Math.min(r.deutan, r.protan))).toFixed(1)}`,
);
if (failed) {
  console.error("\nREGRESSION — a colour is below the set's measured baseline.");
  process.exit(1);
}
console.log("pass");
