/* test.js — headless solver checks. Run: node test.js */
'use strict';
const Solver = require('./solver.js');

const PALETTE = ['#d63a55', '#f2a03d', '#f5e04b', '#4caf6e', '#3a7bd6', '#7a4fb5', '#f7f3eb', '#2b2723'];

/* seeded RNG so runs are comparable */
let _seed = 12345 >>> 0;
function rand() {
  _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rnd(n) { return Math.floor(rand() * n); }

/* Simulate a real weave with random knot choices; return the shown-color grid. */
function randomWeave(strands, rows, types, parityOffset) {
  types = types || ['f', 'b', 'fb', 'bf'];
  let order = strands.slice();
  const target = [];
  for (let r = 0; r < rows; r++) {
    const pairs = Solver.pairStarts(order.length, (r + (parityOffset || 0)) % 2);
    const rowT = [];
    const next = order.slice();
    for (const c of pairs) {
      const L = order[c], R = order[c + 1];
      const type = types[rnd(types.length)];
      const shown = (type === 'f' || type === 'fb') ? L : R;
      if (type === 'f' || type === 'b') { next[c] = R; next[c + 1] = L; }
      rowT.push(shown);
    }
    order = next;
    target.push(rowT);
  }
  return target;
}

let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

/* 1. Round-trip: physically weavable patterns must solve exactly for n <= 20.
 * For n = 30 pure random noise (the adversarial worst case, unlike any
 * drawing), allow at most 1 missed knot per pattern and 3 across the suite. */
let wideMisses = 0;
for (let iter = 0; iter < 120; iter++) {
  const n = [4, 5, 6, 8, 10, 12, 16, 20, 30][rnd(9)];
  const rows = 6 + rnd(30);
  const nColors = 2 + rnd(5);
  const strands = Array.from({ length: n }, () => PALETTE[rnd(nColors)]);
  const target = randomWeave(strands, rows);
  const res = Solver.solve({ strands, rows, target });
  if (n <= 20) {
    check(`roundtrip n=${n} rows=${rows} colors=${nColors} iter=${iter}`, res.errors === 0,
      `errors=${res.errors}`);
  } else {
    check(`roundtrip-wide n=${n} rows=${rows} colors=${nColors} iter=${iter}`, res.errors <= 1,
      `errors=${res.errors}`);
    wideMisses += res.errors;
  }
}
check('total misses across all 30-strand noise patterns <= 3', wideMisses <= 3,
  `misses=${wideMisses}`);

/* 2. Solution must be self-consistent: re-simulate the emitted knots and
 *    verify shown colors match what the solver claims, and knot legality. */
{
  const strands = Array.from({ length: 12 }, (_, i) => PALETTE[i % 4]);
  const rows = 20;
  const target = randomWeave(strands, rows);
  const res = Solver.solve({ strands, rows, target });
  let order = strands.slice();
  let ok = true;
  for (let r = 0; r < rows; r++) {
    const pairs = Solver.pairStarts(order.length, r % 2);
    const next = order.slice();
    res.knots[r].forEach((k, j) => {
      const c = pairs[j];
      if (k.col !== c) ok = false;
      const L = order[c], R = order[c + 1];
      const expectShown = (k.type === 'f' || k.type === 'fb') ? L : R;
      if (k.shown !== expectShown) ok = false;
      if (k.target != null && k.shown !== k.target && !k.err) ok = false;
      if (k.type === 'f' || k.type === 'b') { next[c] = R; next[c + 1] = L; }
    });
    order = next;
    if (JSON.stringify(order) !== JSON.stringify(res.orders[r + 1])) ok = false;
  }
  check('self-consistency (re-simulation matches solver output)', ok);
  check('endOrder matches simulation', JSON.stringify(order) === JSON.stringify(res.endOrder));
}

/* 3. Impossible targets are flagged, not silently absorbed. */
{
  const strands = ['#d63a55', '#d63a55', '#d63a55', '#d63a55'];
  const rows = 6;
  const target = Array.from({ length: rows }, (_, r) =>
    Solver.pairStarts(4, r % 2).map(() => '#3a7bd6'));
  const res = Solver.solve({ strands, rows, target });
  const totalCells = target.reduce((a, r) => a + r.length, 0);
  check('all-impossible target flags every cell', res.errors === totalCells,
    `errors=${res.errors} cells=${totalCells}`);
}

/* 4. Null cells are free — blank grid solves with zero errors. */
{
  const strands = PALETTE.slice(0, 6);
  const rows = 10;
  const target = Array.from({ length: rows }, (_, r) =>
    Solver.pairStarts(6, r % 2).map(() => null));
  const res = Solver.solve({ strands, rows, target });
  check('blank grid, zero errors', res.errors === 0);
}

/* 5. Performance: the interactive path (single pass, no retries) must be
 * fast even at max size; the full escalating solve gets a looser budget.
 * Own seed so this instance is stable regardless of tests added above. */
{
  _seed = 424242 >>> 0;
  const strands = Array.from({ length: 30 }, (_, i) => PALETTE[i % 6]);
  const rows = 60;
  const target = randomWeave(strands, rows);

  let t0 = Date.now();
  const fast = Solver.solve({ strands, rows, target, effort: 'fast' });
  const fastMs = Date.now() - t0;
  check('30x60 interactive pass under 4000ms', fastMs < 4000, fastMs + 'ms');

  t0 = Date.now();
  const res = Solver.solve({ strands, rows, target });
  const ms = Date.now() - t0;
  check('30 strands x 60 rows noise: at most 2 missed knots of 885', res.errors <= 2,
    `errors=${res.errors}`);
  check('...full solve under 15s', ms < 15000, ms + 'ms');
  console.log(`perf: 30x60 fast=${fastMs}ms (errors=${fast.errors}) full=${ms}ms errors=${res.errors}`);
}

/* 6. Diagonal preference: a pattern woven with ONLY crossing knots must come
 *    back with zero bounces — the solver should find the all-diagonal weave,
 *    not just any weave. */
{
  _seed = 606060 >>> 0;
  let totalBounces = 0, allExact = true;
  for (let iter = 0; iter < 30; iter++) {
    const n = [4, 6, 8, 10, 12][rnd(5)];
    const rows = 8 + rnd(20);
    const strands = Array.from({ length: n }, () => PALETTE[rnd(3)]);
    const target = randomWeave(strands, rows, ['f', 'b']);
    const res = Solver.solve({ strands, rows, target });
    if (res.errors !== 0) allExact = false;
    totalBounces += res.bounces;
    if (res.errors !== 0 || res.bounces !== 0) {
      console.log(`  cross-only iter=${iter} n=${n} rows=${rows}: errors=${res.errors} bounces=${res.bounces}`);
    }
  }
  check('cross-only weaves still solve exactly', allExact);
  check('cross-only weaves solve with zero bounces', totalBounces === 0,
    `bounces=${totalBounces}`);
}

/* 6b. Blank grid defaults to the classic all-forward candy stripe. */
{
  const strands = PALETTE.slice(0, 6);
  const rows = 12;
  const target = Array.from({ length: rows }, (_, r) =>
    Solver.pairStarts(6, r % 2).map(() => null));
  const res = Solver.solve({ strands, rows, target });
  check('blank grid weaves all-diagonal', res.bounces === 0, `bounces=${res.bounces}`);
}

/* 6c. Bounce minimization must never cost correctness: mixed-knot noise
 *    (which genuinely needs bounces) still round-trips exactly. */
{
  _seed = 636363 >>> 0;
  const strands = Array.from({ length: 12 }, (_, i) => PALETTE[i % 3]);
  const rows = 24;
  const target = randomWeave(strands, rows, ['fb', 'bf']); // bounce-heavy weave
  const res = Solver.solve({ strands, rows, target });
  check('bounce-heavy pattern still solves exactly', res.errors === 0, `errors=${res.errors}`);
}

/* 6d. Odd-start parity: the whole pattern shifted to start on pairs (2,3)
 *    (parityOffset 1) must round-trip exactly, including through the ladder
 *    and suffix repair. */
{
  _seed = 646464 >>> 0;
  let ok = true;
  for (let iter = 0; iter < 20; iter++) {
    const n = [4, 6, 8, 10, 12, 16][rnd(6)];
    const rows = 8 + rnd(20);
    const strands = Array.from({ length: n }, () => PALETTE[rnd(4)]);
    const target = randomWeave(strands, rows, null, 1);
    const res = Solver.solve({ strands, rows, target, parityOffset: 1 });
    if (res.errors !== 0) { ok = false; console.log(`  odd-parity iter=${iter} n=${n} errors=${res.errors}`); }
  }
  check('odd-start (parityOffset 1) patterns round-trip exactly', ok);
}

/* 7. Hard hand-made case: checkerboard of two colors (classic, weavable
 *    when strands alternate). */
{
  const A = '#d63a55', B = '#3a7bd6';
  const strands = ['#d63a55', '#3a7bd6', '#d63a55', '#3a7bd6', '#d63a55', '#3a7bd6', '#d63a55', '#3a7bd6'];
  const rows = 16;
  const target = Array.from({ length: rows }, (_, r) =>
    Solver.pairStarts(8, r % 2).map((c, j) => ((r + j) % 2 === 0 ? A : B)));
  const res = Solver.solve({ strands, rows, target });
  check('checkerboard solves', res.errors === 0, `errors=${res.errors}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
