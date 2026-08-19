/* app.js — Friendship Loom editor: paint canvas, solver hookup, diagram. */
'use strict';

/* ════════════════ state ════════════════ */

/* 20 floss colors offered in the strand color picker */
const FLOSS = {
  cream: '#f7f3eb', ink: '#2b2723', brown: '#8a5a3b', red: '#d63a55',
  raspberry: '#b23a5e', coral: '#f2705b', orange: '#f2a03d', gold: '#d9a531',
  yellow: '#f5e04b', lime: '#a8c94b', green: '#4caf6e', forest: '#2e6b46',
  mint: '#9adbb5', teal: '#2e8f8a', sky: '#8fc6e8', blue: '#3a7bd6',
  navy: '#2c4a7c', purple: '#7a4fb5', lavender: '#b9a3e3', pink: '#f29dc0',
};

const PRESETS = {
  rainbow: [FLOSS.red, FLOSS.red, FLOSS.orange, FLOSS.orange, FLOSS.yellow, FLOSS.yellow,
            FLOSS.green, FLOSS.green, FLOSS.blue, FLOSS.blue, FLOSS.purple, FLOSS.purple],
  berry:   [FLOSS.raspberry, FLOSS.cream, FLOSS.raspberry, FLOSS.cream,
            FLOSS.raspberry, FLOSS.cream, FLOSS.raspberry, FLOSS.cream],
  ocean:   [FLOSS.navy, FLOSS.blue, FLOSS.teal, FLOSS.sky, FLOSS.cream,
            FLOSS.cream, FLOSS.sky, FLOSS.teal, FLOSS.blue, FLOSS.navy],
  flame:   [FLOSS.ink, FLOSS.red, FLOSS.orange, FLOSS.yellow, FLOSS.cream,
            FLOSS.cream, FLOSS.yellow, FLOSS.orange, FLOSS.red, FLOSS.ink],
  forest:  [FLOSS.forest, FLOSS.green, FLOSS.yellow, FLOSS.cream,
            FLOSS.cream, FLOSS.yellow, FLOSS.green, FLOSS.forest],
  mono:    [FLOSS.ink, FLOSS.cream, FLOSS.ink, FLOSS.cream, FLOSS.ink, FLOSS.cream],
};

const ASCII_EXAMPLES = {
  heart: ' XX XX \nXXXXXXX\nXXXXXXX\n XXXXX \n  XXX  \n   X   ',
  star: '   X   \n  XXX  \nXXXXXXX\n XXXXX \n  XXX  \n XX XX ',
  zigzag: 'X   X   X\nXX XXX XX\n XXX XXX \n  X   X  ',
  hi: 'X X XXX\nX X  X \nXXX  X \nX X  X \nX X XXX',
};

const state = {
  strands: PRESETS.rainbow.slice(),
  rows: 20,
  startParity: 0,    // 0: row 1 knots strands 1-2, 3-4…  1: row 1 knots 2-3, 4-5…
  grid: [],          // grid[r][j] = hex | null
  tool: 'brush',
  activeColor: null,
  symmetry: false,
  solution: null,
  solveMs: 0,
};

const undoStack = [];

/* ════════════════ helpers ════════════════ */

const $ = (id) => document.getElementById(id);
const pairStarts = Solver.pairStarts;

function rowParity(r) { return (r + state.startParity) % 2; }

function knotsInRow(r) { return pairStarts(state.strands.length, rowParity(r)).length; }

function rebuildGrid() {
  const g = [];
  for (let r = 0; r < state.rows; r++) {
    const k = knotsInRow(r);
    const old = state.grid[r] || [];
    const row = [];
    for (let j = 0; j < k; j++) row.push(old[j] !== undefined ? old[j] : null);
    g.push(row);
  }
  state.grid = g;
}

function distinctColors() {
  const seen = [];
  for (const c of state.strands) if (!seen.includes(c)) seen.push(c);
  return seen;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
const inkOn = (hex) => luminance(hex) > 0.55 ? '#2a251f' : '#ffffff';

function colorLetters() {
  // letters A, B, C… per distinct color, like braceletbook diagrams
  const map = new Map();
  distinctColors().forEach((c, i) => map.set(c, String.fromCharCode(65 + (i % 26))));
  return map;
}

function pushUndo() {
  undoStack.push(JSON.stringify(state.grid));
  if (undoStack.length > 80) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return;
  state.grid = JSON.parse(undoStack.pop());
  rebuildGrid();
  renderCanvas();
  scheduleSolve(false);
  persist();
}

/* ════════════════ knot arrow glyphs ════════════════ */

function headPath(tipX, tipY, angleDeg) {
  const a = angleDeg * Math.PI / 180, len = 4.4, spread = 0.5;
  const p = (da) => `${(tipX - len * Math.cos(a + da)).toFixed(2)} ${(tipY - len * Math.sin(a + da)).toFixed(2)}`;
  return `M ${p(spread)} L ${tipX} ${tipY} L ${p(-spread)}`;
}

const GLYPHS = {
  f:  { main: 'M -4.4 -4.4 L 4.2 4.2', head: headPath(4.2, 4.2, 45) },
  b:  { main: 'M 4.4 -4.4 L -4.2 4.2', head: headPath(-4.2, 4.2, 135) },
  fb: { main: 'M -4.2 -4.6 Q 5.2 -1.5 -2 4.8', head: headPath(-2, 4.8, 139) },
  bf: { main: 'M 4.2 -4.6 Q -5.2 -1.5 2 4.8', head: headPath(2, 4.8, 41) },
};

function arrowSvg(type, scale) {
  const g = GLYPHS[type];
  const s = scale || 1;
  return `<g transform="scale(${s})" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${g.main}" stroke="rgba(0,0,0,0.45)" stroke-width="3.4"/>` +
    `<path d="${g.head}" stroke="rgba(0,0,0,0.45)" stroke-width="3.4"/>` +
    `<path d="${g.main}" stroke="#fff" stroke-width="1.9"/>` +
    `<path d="${g.head}" stroke="#fff" stroke-width="1.9"/></g>`;
}

/* ════════════════ paint canvas ════════════════ */

const CV = { cw: 34, rh: 24, r: 12.5, padX: 26, padTop: 46 };

function canvasSize() {
  const n = state.strands.length;
  return {
    w: CV.padX * 2 + (n - 1) * CV.cw,
    h: CV.padTop + (state.rows - 1) * CV.rh + CV.r + 14,
  };
}

function cellCenter(r, j) {
  const c = rowParity(r) + 2 * j;
  return { x: CV.padX + (c + 0.5) * CV.cw, y: CV.padTop + r * CV.rh };
}

function renderCanvas() {
  const svg = $('canvas');
  const { w, h } = canvasSize();
  const zoom = parseFloat($('zoom-canvas').value);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w * zoom);
  svg.setAttribute('height', h * zoom);

  const parts = [];
  // strand chips: starting order across the top
  state.strands.forEach((col, c) => {
    const x = CV.padX + c * CV.cw;
    parts.push(`<circle cx="${x}" cy="16" r="8" fill="${col}" stroke="rgba(0,0,0,0.3)"/>`);
  });
  parts.push(`<line x1="${CV.padX - 12}" y1="30" x2="${w - CV.padX + 12}" y2="30" stroke="#d9d2c2" stroke-dasharray="3 4"/>`);

  const sol = state.solution;
  for (let r = 0; r < state.rows; r++) {
    const k = knotsInRow(r);
    for (let j = 0; j < k; j++) {
      const { x, y } = cellCenter(r, j);
      const t = state.grid[r][j];
      const kn = sol && sol.knots[r] && sol.knots[r][j];
      if (t != null) {
        parts.push(`<circle data-cell="${r},${j}" cx="${x}" cy="${y}" r="${CV.r}" fill="${t}" stroke="rgba(0,0,0,0.35)"/>`);
      } else {
        // auto cell: ghost of what the solver chose to weave here
        const ghost = kn ? kn.shown : '#e8e3d7';
        parts.push(`<circle data-cell="${r},${j}" cx="${x}" cy="${y}" r="${CV.r}" fill="${ghost}" fill-opacity="0.26" stroke="#bfb6a1" stroke-dasharray="3 3"/>`);
      }
      if (kn && kn.err) {
        parts.push(`<circle cx="${x}" cy="${y}" r="${CV.r + 3}" fill="none" stroke="#c23434" stroke-width="2" stroke-dasharray="4 3"><title>no thread of this color reaches here — got ${kn.shown}</title></circle>`);
      }
    }
  }
  svg.innerHTML = parts.join('');
}

function cellFromEvent(ev) {
  const svg = $('canvas');
  const rect = svg.getBoundingClientRect();
  const { w } = canvasSize();
  const scale = rect.width / w;
  const px = (ev.clientX - rect.left) / scale;
  const py = (ev.clientY - rect.top) / scale;
  const r = Math.round((py - CV.padTop) / CV.rh);
  if (r < 0 || r >= state.rows) return null;
  const j = Math.round(((px - CV.padX) / CV.cw - 0.5 - rowParity(r)) / 2);
  if (j < 0 || j >= knotsInRow(r)) return null;
  const { x, y } = cellCenter(r, j);
  if (Math.hypot(px - x, py - y) > CV.r * 1.35) return null;
  return { r, j };
}

function setCell(r, j, val) {
  if (state.grid[r][j] === val) return false;
  state.grid[r][j] = val;
  if (state.symmetry) {
    const jm = knotsInRow(r) - 1 - j;
    state.grid[r][jm] = val;
  }
  return true;
}

function cellNeighbors(r, j) {
  const out = [];
  const c = rowParity(r) + 2 * j;
  if (j > 0) out.push([r, j - 1]);
  if (j + 1 < knotsInRow(r)) out.push([r, j + 1]);
  for (const dr of [-1, 1]) {
    const r2 = r + dr;
    if (r2 < 0 || r2 >= state.rows) continue;
    const p2 = rowParity(r2);
    for (const c2 of [c - 1, c + 1]) {
      if ((c2 - p2) % 2 !== 0) continue;
      const j2 = (c2 - p2) / 2;
      if (j2 >= 0 && j2 < knotsInRow(r2)) out.push([r2, j2]);
    }
  }
  return out;
}

function floodFill(r, j, val) {
  const from = state.grid[r][j];
  if (from === val) return;
  const q = [[r, j]];
  const seen = new Set([r + ',' + j]);
  while (q.length) {
    const [cr, cj] = q.pop();
    if (state.grid[cr][cj] !== from) continue;
    state.grid[cr][cj] = val;
    for (const [nr, nj] of cellNeighbors(cr, cj)) {
      const key = nr + ',' + nj;
      if (!seen.has(key)) { seen.add(key); q.push([nr, nj]); }
    }
  }
}

let painting = false;

function paintAt(ev, isStart) {
  const cell = cellFromEvent(ev);
  if (!cell) return;
  const val = state.tool === 'erase' ? null : state.activeColor;
  if (state.tool === 'fill') {
    if (!isStart) return;
    pushUndo();
    floodFill(cell.r, cell.j, val);
  } else {
    if (isStart) pushUndo();
    if (!setCell(cell.r, cell.j, val)) return;
  }
  renderCanvas();
  scheduleSolve(true);
  persist();
}

function bindCanvas() {
  const svg = $('canvas');
  svg.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    painting = true;
    paintAt(ev, true);
  });
  svg.addEventListener('pointermove', (ev) => { if (painting) paintAt(ev, false); });
  const end = () => {
    if (!painting) return;
    painting = false;
    scheduleSolve(false); // full-effort pass once the stroke ends
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

/* ════════════════ solving ════════════════ */

let solveTimer = null;

function scheduleSolve(fast) {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(() => runSolve(fast), fast ? 30 : 180);
}

function runSolve(fast) {
  const t0 = performance.now();
  state.solution = Solver.solve({
    strands: state.strands,
    rows: state.rows,
    target: state.grid,
    parityOffset: state.startParity,
    effort: fast ? 'fast' : undefined,
    budgetMs: 2500,
  });
  state.solveMs = performance.now() - t0;
  renderStats();
  renderPreview();
  renderDiagram();
  renderCanvas();
}

function renderStats() {
  const sol = state.solution;
  if (!sol) return;
  const errEl = $('stat-errors');
  errEl.textContent = sol.errors === 0 ? 'every cell weavable' : `${sol.errors} unreachable cell${sol.errors > 1 ? 's' : ''}`;
  errEl.className = 'stat ' + (sol.errors === 0 ? 'ok' : 'bad');
  const bn = $('stat-bounce');
  const bounces = sol.bounces !== undefined ? sol.bounces
    : sol.knots.flat().filter((k) => k.type === 'fb' || k.type === 'bf').length;
  bn.textContent = bounces === 0 ? 'all diagonal — tight weave' : `${bounces} double-back${bounces > 1 ? 's' : ''}`;
  bn.className = 'stat ' + (bounces === 0 ? 'ok' : '');
  const rep = $('stat-repeat');
  rep.textContent = sol.repeats ? 'repeats seamlessly' : 'end order differs from start';
  rep.className = 'stat ' + (sol.repeats ? 'ok' : '');
  $('stat-time').textContent = `${Math.round(state.solveMs)} ms`;
}

/* ════════════════ woven preview ════════════════ */

function renderPreview() {
  const sol = state.solution;
  if (!sol) return;
  const svg = $('preview');
  // Diamonds tile edge-to-edge like the knots of a real bracelet: half-width
  // equals the column spacing, half-height equals the row spacing (plus a
  // hair of overlap so no background peeks through the seams).
  const cw = 9, rh = 11, padX = 14, padTop = 14, hw = 9.35, hh = 11.4;
  const n = state.strands.length;
  const w = padX * 2 + (n - 1) * cw;
  const h = padTop + (state.rows - 1) * rh + 14;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  const parts = [];
  const dia = (x, y) => `M ${x} ${y - hh} L ${x + hw} ${y} L ${x} ${y + hh} L ${x - hw} ${y} Z`;
  const errs = [];
  for (let r = 0; r < state.rows; r++) {
    (sol.knots[r] || []).forEach((kn, j) => {
      const c = rowParity(r) + 2 * j;
      const x = padX + (c + 0.5) * cw, y = padTop + r * rh;
      parts.push(`<path d="${dia(x, y)}" fill="${kn.shown}" stroke="rgba(0,0,0,0.10)" stroke-width="0.5"/>`);
      // faint knot ridge, like the V of a real half-hitch
      parts.push(`<path d="M ${x - hw * 0.55} ${y - hh * 0.08} L ${x} ${y + hh * 0.42} L ${x + hw * 0.55} ${y - hh * 0.08}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>`);
      if (kn.err) errs.push(`<path d="${dia(x, y)}" fill="none" stroke="#c23434" stroke-width="1.6"/>`);
    });
  }
  svg.innerHTML = parts.join('') + errs.join('');
}

/* ════════════════ knot diagram ════════════════ */

const DG = { cw: 28, rh: 26, r: 10.5, mx: 34, mt: 40 };

function renderDiagram() {
  const sol = state.solution;
  if (!sol) return;
  const svg = $('diagram');
  const n = state.strands.length;
  const rows = state.rows;
  const w = DG.mx * 2 + (n - 1) * DG.cw;
  const h = DG.mt + rows * DG.rh + 36;
  const zoom = parseFloat($('zoom-diagram').value);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w * zoom);
  svg.setAttribute('height', h * zoom);

  const X = (c) => DG.mx + c * DG.cw;
  const yB = (r) => DG.mt + r * DG.rh;
  const letters = colorLetters();

  // thread occupancy per row boundary (occ[r][c] = strand index)
  const occ = [Array.from({ length: n }, (_, i) => i)];
  for (let r = 0; r < rows; r++) {
    const next = occ[r].slice();
    sol.knots[r].forEach((kn) => {
      if (kn.type === 'f' || kn.type === 'b') {
        const c = kn.col;
        [next[c], next[c + 1]] = [next[c + 1], next[c]];
      }
    });
    occ.push(next);
  }
  const colOf = occ.map((row) => {
    const inv = new Array(n);
    row.forEach((strand, c) => { inv[strand] = c; });
    return inv;
  });

  const parts = [];

  // threads
  for (let i = 0; i < n; i++) {
    const col = state.strands[i];
    const pts = [`${X(colOf[0][i])},${yB(0) - 10}`];
    for (let r = 0; r < rows; r++) {
      const cb = colOf[r][i];
      const kn = sol.knots[r].find((k) => k.col === cb || k.col + 1 === cb);
      if (kn) pts.push(`${X(kn.col) + DG.cw / 2},${yB(r) + DG.rh / 2}`);
      pts.push(`${X(colOf[r + 1][i])},${yB(r + 1)}`);
    }
    pts.push(`${X(colOf[rows][i])},${yB(rows) + 10}`);
    const pl = pts.join(' ');
    // faint dark understroke keeps pale threads readable on the linen ground
    parts.push(`<polyline points="${pl}" fill="none" stroke="rgba(0,0,0,0.22)" stroke-width="4.6" stroke-linejoin="round" stroke-linecap="round"/>`);
    parts.push(`<polyline points="${pl}" fill="none" stroke="${col}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>`);
  }

  // knots
  for (let r = 0; r < rows; r++) {
    const cy = yB(r) + DG.rh / 2;
    parts.push(`<text x="${DG.mx - 22}" y="${cy + 3.5}" font-family="Spline Sans Mono, monospace" font-size="10" fill="#8d8375">${r + 1}</text>`);
    parts.push(`<text x="${w - DG.mx + 14}" y="${cy + 3.5}" font-family="Spline Sans Mono, monospace" font-size="10" fill="#8d8375">${r + 1}</text>`);
    sol.knots[r].forEach((kn) => {
      const cx = X(kn.col) + DG.cw / 2;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${DG.r}" fill="${kn.shown}" stroke="rgba(0,0,0,0.4)" stroke-width="1"/>`);
      parts.push(`<g transform="translate(${cx} ${cy})">${arrowSvg(kn.type)}</g>`);
      if (kn.err) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${DG.r + 3.5}" fill="none" stroke="#c23434" stroke-width="2" stroke-dasharray="4 3"/>`);
      }
    });
  }

  // strand chips top (start order) and bottom (end order)
  const chip = (c, col, y) => {
    const x = X(c);
    return `<circle cx="${x}" cy="${y}" r="8.5" fill="${col}" stroke="rgba(0,0,0,0.35)"/>` +
      `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-family="Spline Sans Mono, monospace" font-size="9" font-weight="600" fill="${inkOn(col)}">${letters.get(col) || ''}</text>`;
  };
  state.strands.forEach((col, c) => parts.push(chip(c, col, yB(0) - 22)));
  sol.endOrder.forEach((col, c) => parts.push(chip(c, col, yB(rows) + 22)));

  svg.innerHTML = parts.join('');
}

/* ════════════════ legend ════════════════ */

function renderLegend() {
  const items = [
    ['f', 'forward — cross'],
    ['b', 'backward — cross'],
    ['fb', 'fwd-back — bounce'],
    ['bf', 'back-fwd — bounce'],
  ];
  $('legend').innerHTML = items.map(([t, name]) =>
    `<span class="lg"><svg width="26" height="26" viewBox="-13 -13 26 26">` +
    `<circle r="10.5" fill="#a89b8a" stroke="rgba(0,0,0,0.35)"/>${arrowSvg(t)}</svg>${name}</span>`
  ).join('');
}

/* ════════════════ strand editor & palette ════════════════ */

function setStrandColor(i, hex) {
  const old = state.strands[i];
  if (old === hex) return;
  state.strands[i] = hex;
  if (!state.strands.includes(old)) {
    // color left the palette entirely: repaint its cells to the new color
    for (const row of state.grid) {
      for (let j = 0; j < row.length; j++) if (row[j] === old) row[j] = hex;
    }
  }
  afterSetupChange();
}

/* ── strand color popover: 20 floss swatches + custom ── */

let popStrand = -1;
let popOpenedAt = 0;

function openColorPop(i, anchor) {
  const pop = $('color-pop');
  popStrand = i;
  pop.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'pop-grid';
  Object.entries(FLOSS).forEach(([name, hex]) => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.strands[i] === hex ? ' active' : '');
    b.style.background = hex;
    b.title = name;
    b.addEventListener('click', () => {
      setStrandColor(popStrand, hex);
      closeColorPop();
    });
    grid.appendChild(b);
  });
  pop.appendChild(grid);

  const custom = document.createElement('label');
  custom.className = 'pop-custom';
  custom.append('custom…');
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = state.strands[i];
  inp.addEventListener('input', () => setStrandColor(popStrand, inp.value));
  custom.appendChild(inp);
  pop.appendChild(custom);

  pop.hidden = false;
  popOpenedAt = performance.now();
  const r = anchor.getBoundingClientRect();
  const pw = 196; // keep the popover on screen
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 200) + 'px';
}

function closeColorPop() {
  $('color-pop').hidden = true;
  popStrand = -1;
}

function renderStrands() {
  $('strand-count').textContent = state.strands.length;
  $('rows-count').value = state.rows;
  $('btn-parity').textContent = state.startParity === 0 ? 'knots 1·2 first' : 'knots 2·3 first';
  const list = $('strand-list');
  list.innerHTML = '';
  state.strands.forEach((col, i) => {
    const b = document.createElement('button');
    b.className = 'bobbin';
    b.style.background = col;
    b.dataset.n = i + 1;
    b.dataset.i = i;
    b.title = `strand ${i + 1} — ${col} (click to recolor, drag to reorder)`;
    b.addEventListener('pointerdown', (ev) => startBobbinDrag(ev, b));
    b.addEventListener('click', () => {
      if (bobbinDragged) { bobbinDragged = false; return; }
      openColorPop(+b.dataset.i, b);
    });
    list.appendChild(b);
  });
}

/* ── drag bobbins to reorder the starting threads ── */

let bobbinDragged = false;

function startBobbinDrag(ev, el) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const list = $('strand-list');
  const sx = ev.clientX, sy = ev.clientY;
  let dragging = false;
  const move = (mv) => {
    if (!dragging) {
      if (Math.hypot(mv.clientX - sx, mv.clientY - sy) < 7) return;
      dragging = true;
      bobbinDragged = true;
      closeColorPop();
      el.classList.add('dragging');
    }
    mv.preventDefault();
    const over = document.elementFromPoint(mv.clientX, mv.clientY);
    const tgt = over && over.closest ? over.closest('.bobbin') : null;
    if (tgt && tgt !== el && tgt.parentNode === list) {
      const r = tgt.getBoundingClientRect();
      const before = mv.clientX < r.left + r.width / 2;
      list.insertBefore(el, before ? tgt : tgt.nextSibling);
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!dragging) return;
    el.classList.remove('dragging');
    state.strands = Array.from(list.children).map((x) => state.strands[+x.dataset.i]);
    afterSetupChange(); // re-render renumbers the bobbins
    setTimeout(() => { bobbinDragged = false; }, 0); // outlive the trailing click
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function renderPalette() {
  const pal = $('palette');
  pal.innerHTML = '';
  const colors = distinctColors();
  if (!colors.includes(state.activeColor)) state.activeColor = colors[0];
  colors.forEach((col) => {
    const b = document.createElement('button');
    b.className = 'chip' + (col === state.activeColor && state.tool !== 'erase' ? ' active' : '');
    b.style.background = col;
    b.title = col;
    b.addEventListener('click', () => {
      state.activeColor = col;
      if (state.tool === 'erase') setTool('brush');
      renderPalette();
    });
    pal.appendChild(b);
  });
  const auto = document.createElement('button');
  auto.className = 'chip auto' + (state.tool === 'erase' ? ' active' : '');
  auto.title = 'auto (erase) — solver picks';
  auto.addEventListener('click', () => setTool('erase'));
  pal.appendChild(auto);
}

function setTool(tool) {
  state.tool = tool;
  for (const id of ['brush', 'fill', 'erase']) {
    $('tool-' + id).classList.toggle('active', tool === id);
  }
  renderPalette();
}

function afterSetupChange() {
  rebuildGrid();
  renderStrands();
  renderPalette();
  renderCanvas();
  scheduleSolve(false);
  persist();
}

/* ════════════════ ASCII import ════════════════ */

const asciiMap = new Map(); // char -> hex | null

function renderAsciiMap() {
  const text = $('ascii-text').value;
  const chars = [];
  for (const ch of text) if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '.' && !chars.includes(ch)) chars.push(ch);
  const colors = distinctColors();
  const box = $('ascii-map');
  box.innerHTML = '';
  chars.slice(0, 12).forEach((ch, i) => {
    if (!asciiMap.has(ch) || (asciiMap.get(ch) && !colors.includes(asciiMap.get(ch)))) {
      asciiMap.set(ch, colors[i % colors.length]);
    }
    const row = document.createElement('div');
    row.className = 'map-row';
    const tag = document.createElement('span');
    tag.className = 'map-char';
    tag.textContent = ch;
    row.appendChild(tag);
    colors.forEach((col) => {
      const b = document.createElement('button');
      b.className = 'chip' + (asciiMap.get(ch) === col ? ' active' : '');
      b.style.background = col;
      b.addEventListener('click', () => { asciiMap.set(ch, col); renderAsciiMap(); });
      row.appendChild(b);
    });
    box.appendChild(row);
  });
}

function stampAscii() {
  const lines = $('ascii-text').value.replace(/\r/g, '').split('\n').filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
  if (!lines.length) return;
  pushUndo();
  const artW = Math.max(...lines.map((l) => l.length));
  const rOff = Math.max(0, Math.floor((state.rows - lines.length) / 2));
  lines.forEach((line, i) => {
    const r = rOff + i;
    if (r >= state.rows) return;
    const k = knotsInRow(r);
    const jOff = Math.floor((k - artW) / 2);
    for (let x = 0; x < line.length; x++) {
      const j = jOff + x;
      if (j < 0 || j >= k) continue;
      const ch = line[x];
      if (ch === ' ') continue;           // spaces leave cells untouched
      if (ch === '.') { state.grid[r][j] = null; continue; } // dots erase
      const col = asciiMap.get(ch);
      if (col) state.grid[r][j] = col;
    }
  });
  $('ascii-dialog').close();
  renderCanvas();
  scheduleSolve(false);
  persist();
}

/* ════════════════ exports ════════════════ */

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function diagramSvgText() {
  const svg = $('diagram').cloneNode(true);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.insertAdjacentHTML('afterbegin', `<rect width="100%" height="100%" fill="#fbfaf6"/>`);
  return svg.outerHTML;
}

function exportSvg() {
  download('bracelet-diagram.svg', new Blob([diagramSvgText()], { type: 'image/svg+xml' }));
}

function exportPng() {
  const svgEl = $('diagram');
  const vb = svgEl.getAttribute('viewBox').split(' ');
  const w = parseFloat(vb[2]), h = parseFloat(vb[3]);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([diagramSvgText()], { type: 'image/svg+xml' }));
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = w * 2; cv.height = h * 2;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    cv.toBlob((b) => download('bracelet-diagram.png', b));
  };
  img.src = url;
}

const TYPE_NAMES = { f: 'F (forward)', b: 'B (backward)', fb: 'FB (fwd-back)', bf: 'BF (back-fwd)' };

function exportInstructions() {
  const sol = state.solution;
  if (!sol) return;
  const letters = colorLetters();
  const lines = [];
  lines.push('FRIENDSHIP LOOM — weaving instructions');
  lines.push('');
  lines.push('Threads, left to right:');
  lines.push('  ' + state.strands.map((c, i) => `${i + 1}:${letters.get(c)}(${c})`).join('  '));
  lines.push('');
  lines.push('Knots: F = forward (cross, shows left thread), B = backward (cross, shows right),');
  lines.push('       FB = forward-backward (bounce, shows left), BF = backward-forward (bounce, shows right).');
  lines.push('Positions are thread slots at the moment of tying (1 = leftmost).');
  lines.push('');
  sol.knots.forEach((row, r) => {
    const items = row.map((kn) => `${kn.col + 1}-${kn.col + 2}: ${TYPE_NAMES[kn.type].split(' ')[0]}${kn.err ? ' (!)' : ''}`);
    lines.push(`Row ${String(r + 1).padStart(2)}: ${items.join('   ')}`);
  });
  lines.push('');
  lines.push(sol.repeats
    ? 'End order matches the start — the pattern repeats seamlessly.'
    : 'End thread order: ' + sol.endOrder.map((c) => letters.get(c)).join(' '));
  if (sol.errors) lines.push(`Cells marked (!) could not reach the painted color (${sol.errors} total).`);
  download('bracelet-instructions.txt', new Blob([lines.join('\n')], { type: 'text/plain' }));
}

function savePattern() {
  const data = { app: 'friendship-loom', version: 1, strands: state.strands, rows: state.rows, startParity: state.startParity, grid: state.grid };
  download('bracelet-pattern.json', new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
}

function loadPattern(file) {
  file.text().then((txt) => {
    const data = JSON.parse(txt);
    if (!Array.isArray(data.strands) || typeof data.rows !== 'number') throw new Error('bad file');
    state.strands = data.strands.slice(0, 30);
    state.rows = Math.max(2, Math.min(100, data.rows));
    state.startParity = data.startParity === 1 ? 1 : 0;
    state.grid = Array.isArray(data.grid) ? data.grid : [];
    afterSetupChange();
  }).catch(() => {
    $('stat-errors').textContent = 'could not read that file';
    $('stat-errors').className = 'stat bad';
  });
}

/* ════════════════ persistence ════════════════ */

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem('floom-v1', JSON.stringify({ strands: state.strands, rows: state.rows, startParity: state.startParity, grid: state.grid }));
    } catch (e) { /* storage full or blocked — losing autosave is fine */ }
  }, 400);
}

function restore() {
  try {
    const raw = localStorage.getItem('floom-v1');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.strands) && data.strands.length >= 2) state.strands = data.strands.slice(0, 30);
    if (typeof data.rows === 'number') state.rows = Math.max(2, Math.min(100, data.rows));
    if (data.startParity === 0 || data.startParity === 1) state.startParity = data.startParity;
    if (Array.isArray(data.grid)) state.grid = data.grid;
  } catch (e) { /* corrupted autosave — start fresh */ }
}

/* ════════════════ wiring ════════════════ */

function bindControls() {
  $('strand-minus').addEventListener('click', () => {
    if (state.strands.length <= 2) return;
    state.strands.pop();
    afterSetupChange();
  });
  $('strand-plus').addEventListener('click', () => {
    if (state.strands.length >= 30) return;
    state.strands.push(state.strands[state.strands.length - 2] || state.strands[0]);
    afterSetupChange();
  });
  $('rows-minus').addEventListener('click', () => {
    if (state.rows <= 2) return;
    state.rows--;
    afterSetupChange();
  });
  $('rows-plus').addEventListener('click', () => {
    if (state.rows >= 100) return;
    state.rows++;
    afterSetupChange();
  });
  $('rows-count').addEventListener('change', (ev) => {
    const v = Math.round(Number(ev.target.value));
    state.rows = Number.isFinite(v) ? Math.max(2, Math.min(100, v)) : state.rows;
    afterSetupChange();
  });
  $('btn-parity').addEventListener('click', () => {
    state.startParity = 1 - state.startParity;
    afterSetupChange();
  });
  $('preset').addEventListener('change', (ev) => {
    const p = PRESETS[ev.target.value];
    ev.target.value = '';
    if (!p) return;
    state.strands = p.slice();
    afterSetupChange();
  });
  $('btn-clear').addEventListener('click', () => {
    pushUndo();
    for (const row of state.grid) row.fill(null);
    renderCanvas();
    scheduleSolve(false);
    persist();
  });
  $('chk-symmetry').addEventListener('change', (ev) => { state.symmetry = ev.target.checked; });

  $('tool-brush').addEventListener('click', () => setTool('brush'));
  $('tool-fill').addEventListener('click', () => setTool('fill'));
  $('tool-erase').addEventListener('click', () => setTool('erase'));
  $('btn-undo').addEventListener('click', undo);

  $('zoom-canvas').addEventListener('input', renderCanvas);
  $('zoom-diagram').addEventListener('input', renderDiagram);

  $('btn-svg').addEventListener('click', exportSvg);
  $('btn-png').addEventListener('click', exportPng);
  $('btn-txt').addEventListener('click', exportInstructions);
  $('btn-save').addEventListener('click', savePattern);
  $('btn-load').addEventListener('click', () => $('file-load').click());
  $('file-load').addEventListener('change', (ev) => {
    if (ev.target.files[0]) loadPattern(ev.target.files[0]);
    ev.target.value = '';
  });

  $('btn-ascii').addEventListener('click', () => {
    renderAsciiMap();
    $('ascii-dialog').showModal();
  });
  $('ascii-cancel').addEventListener('click', () => $('ascii-dialog').close());
  $('ascii-stamp').addEventListener('click', stampAscii);
  $('ascii-text').addEventListener('input', renderAsciiMap);
  $('ascii-example').addEventListener('change', (ev) => {
    const art = ASCII_EXAMPLES[ev.target.value];
    ev.target.value = '';
    if (art) { $('ascii-text').value = art; renderAsciiMap(); }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeColorPop(); return; }
    if (ev.target.matches('input, textarea, select')) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
    if (ev.key === 'b' || ev.key === 'B') setTool('brush');
    if (ev.key === 'f' || ev.key === 'F') setTool('fill');
    if (ev.key === 'e' || ev.key === 'E') setTool('erase');
  });

  // close the color popover on outside clicks (bobbin clicks reopen it; the
  // just-opened guard survives synthetic pointerdown/click orderings)
  document.addEventListener('pointerdown', (ev) => {
    const pop = $('color-pop');
    if (pop.hidden || performance.now() - popOpenedAt < 150) return;
    if (!pop.contains(ev.target) && !ev.target.closest('.bobbin')) closeColorPop();
  });
}

function init() {
  restore();
  rebuildGrid();
  renderStrands();
  renderPalette();
  renderLegend();
  renderCanvas();
  bindCanvas();
  bindControls();
  runSolve(false);
}

init();
