/* solver.js — turns painted pixel targets into a weavable knot pattern.
 *
 * Model (normal friendship bracelet patterns):
 *   - n strands, each with a fixed color. Colors never change; only positions do.
 *   - Row r (0-based) knots adjacent pairs starting at column r%2:
 *       even rows: (0,1) (2,3) ...   odd rows: (1,2) (3,4) ...
 *     Edge strands in odd rows pass straight down.
 *   - Four knot types:
 *       f  (forward):           threads swap,  knot shows LEFT thread color
 *       b  (backward):          threads swap,  knot shows RIGHT thread color
 *       fb (forward-backward):  no swap,       knot shows LEFT thread color
 *       bf (backward-forward):  no swap,       knot shows RIGHT thread color
 *
 * Key insight: the painted target pixel forces WHICH thread's color shows
 * (left or right). The remaining freedom is the swap bit, which only affects
 * future rows. Each next-row knot sits between two adjacent current-row knots,
 * so next-row satisfiability decomposes into a chain over swap bits — solved
 * exactly per row with a k-best DP, wrapped in a beam search over rows.
 *
 * Wildcard strands: a starting strand given as null has no color yet. The
 * solver treats it as a joker that can become any color, and BINDS it the
 * first time a painted cell needs a color neither incoming thread has. Thread
 * identities are tracked through the swaps so the binding lands on the right
 * starting bobbin; wildcards never demanded get a default color at the end.
 * The result's `strands` is the fully resolved starting order.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Solver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hexToRgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const _dc = new Map();
  function colorDist(a, b) {
    if (a === b) return 0;
    const k = a < b ? a + b : b + a;
    let d = _dc.get(k);
    if (d === undefined) {
      const x = hexToRgb(a), y = hexToRgb(b);
      d = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
      _dc.set(k, d);
    }
    return d;
  }

  function pairStarts(n, parity) {
    const out = [];
    for (let c = parity; c + 1 < n; c += 2) out.push(c);
    return out;
  }

  // penalty that a next-row knot with target t cannot be tied from incoming colors X, Y
  function pen(t, X, Y) {
    // a wildcard (null) thread can still become any color: no penalty
    if (t == null || X == null || Y == null || t === X || t === Y) return 0;
    return 1 + Math.min(colorDist(t, X), colorDist(t, Y)) / 2000;
  }

  /* Cost of one bounce knot (fb/bf). Bracelets weave tighter with straight
   * diagonal crosses, so bounces are penalized — but calibrated so that even
   * a solid wall of them (100 rows x 15 knots) stays below ONE unreachable
   * cell: correctness always outranks tightness. */
  const BOUNCE_W = 5e-4;

  function countBounces(knots) {
    let b = 0;
    for (const row of knots) for (const k of row) if (k.type === 'fb' || k.type === 'bf') b++;
    return b;
  }

  // deterministic RNG so identical inputs always solve identically
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Build the chain cost model for one row's swap bits: cost of making the
   * next row's targets unreachable. Returns { unary, pairw, constC, k }. */
  function buildChainCosts(order, pairs, info, nextPairs, nextTargets) {
    const k = pairs.length;
    const dep = {}; // column -> { j, side } for columns owned by a current-row knot
    pairs.forEach(function (c, j) {
      dep[c] = { j, side: 'left' };
      dep[c + 1] = { j, side: 'right' };
    });
    function colColor(c, s) {
      const d = dep[c];
      if (!d) return order[c];
      const L = info[d.j].L, R = info[d.j].R;
      return d.side === 'left' ? (s ? R : L) : (s ? L : R);
    }

    const unary = [];
    for (let j = 0; j < k; j++) unary.push([0, 0]);
    const pairw = [];
    for (let j = 0; j < k - 1; j++) pairw.push([[0, 0], [0, 0]]);
    let constC = 0;

    if (nextTargets) {
      nextPairs.forEach(function (a, m) {
        const t = nextTargets[m];
        if (t == null) return;
        const dA = dep[a], dB = dep[a + 1];
        if (!dA && !dB) {
          constC += pen(t, order[a], order[a + 1]);
        } else if (dA && dB) {
          if (dA.j === dB.j) {
            constC += pen(t, info[dA.j].L, info[dA.j].R);
          } else if (Math.abs(dA.j - dB.j) === 1) {
            const lo = Math.min(dA.j, dB.j);
            for (let s0 = 0; s0 < 2; s0++) for (let s1 = 0; s1 < 2; s1++) {
              const sA = dA.j === lo ? s0 : s1;
              const sB = dB.j === lo ? s0 : s1;
              pairw[lo][s0][s1] += pen(t, colColor(a, sA), colColor(a + 1, sB));
            }
          }
        } else {
          const d = dA || dB;
          const cDep = dA ? a : a + 1, cFix = dA ? a + 1 : a;
          for (let s = 0; s < 2; s++) unary[d.j][s] += pen(t, colColor(cDep, s), order[cFix]);
        }
      });
    }
    return { unary, pairw, constC, k };
  }

  function vecCost(model, vec) {
    let c = 0;
    for (let j = 0; j < model.k; j++) {
      c += model.unary[j][vec[j]];
      if (j + 1 < model.k) c += model.pairw[j][vec[j]][vec[j + 1]];
    }
    return c + model.constC;
  }

  /* Candidate swap vectors for one row: exhaustive when the row is narrow,
   * otherwise K-best chain DP plus diverse backward-sampled optima.
   *
   * Two views of the same cost model: the deterministic K-best runs on
   * cross-BIASED costs (each bounce pays BOUNCE_W) so the tightest weave
   * among pen-ties always surfaces, while the random samples come from the
   * UNBIASED pen-only optimal set — biasing both collapses the sample pool
   * onto near-identical crossy vectors and starves the beam of the routing
   * diversity it needs (bounces are how threads wait for future rows). */
  function kBestSwaps(order, pairs, info, nextPairs, nextTargets, K, samples, rng) {
    const k = pairs.length;
    if (k === 0) return [{ vec: [], cost: 0 }];
    const model = buildChainCosts(order, pairs, info, nextPairs, nextTargets);
    const unaryB = model.unary.map(function (u, j) {
      const bounce = info[j].L !== info[j].R && info[j].bind !== 3;
      return [u[0] + (bounce ? BOUNCE_W : 0), u[1]];
    });
    const modelB = { unary: unaryB, pairw: model.pairw, constC: model.constC, k: k };

    // narrow rows: enumerate everything, exactly (all vectors are present, so
    // biased ordering costs no diversity here)
    if (k <= 7) {
      const out = [];
      for (let mask = 0; mask < (1 << k); mask++) {
        const vec = [];
        for (let j = 0; j < k; j++) vec.push((mask >> j) & 1);
        out.push({ vec, cost: vecCost(modelB, vec) });
      }
      out.sort(function (x, y) { return x.cost - y.cost; });
      return out.slice(0, Math.max(K, samples || 0));
    }

    const pairw = model.pairw, constC = model.constC;

    // K-best chain DP on biased costs
    let dp = [
      [{ cost: unaryB[0][0], vec: [0] }],
      [{ cost: unaryB[0][1], vec: [1] }],
    ];
    for (let j = 1; j < k; j++) {
      const ndp = [[], []];
      for (let s1 = 0; s1 < 2; s1++) {
        const opts = [];
        for (let s0 = 0; s0 < 2; s0++) for (const e of dp[s0]) {
          opts.push({ cost: e.cost + pairw[j - 1][s0][s1] + unaryB[j][s1], vec: e.vec.concat(s1) });
        }
        opts.sort(function (x, y) { return x.cost - y.cost; });
        ndp[s1] = opts.slice(0, K);
      }
      dp = ndp;
    }
    const fin = dp[0].concat(dp[1]).sort(function (x, y) { return x.cost - y.cost; }).slice(0, K)
      .map(function (e) { return { vec: e.vec, cost: e.cost + constC }; });

    // diverse optimal vectors: unbiased forward min-cost table, then backward
    // sampling uniformly among tight transitions
    if (samples && rng) {
      const unary = model.unary;
      const F = [[unary[0][0], unary[0][1]]];
      for (let j = 1; j < k; j++) {
        const row = [0, 0];
        for (let s1 = 0; s1 < 2; s1++) {
          row[s1] = Math.min(F[j - 1][0] + pairw[j - 1][0][s1], F[j - 1][1] + pairw[j - 1][1][s1]) + unary[j][s1];
        }
        F.push(row);
      }
      const EPS = 1e-9;
      const seen = new Set(fin.map(function (e) { return e.vec.join(''); }));
      for (let s = 0; s < samples; s++) {
        const vec = new Array(k);
        const endMin = Math.min(F[k - 1][0], F[k - 1][1]);
        const endOpts = [0, 1].filter(function (b) { return F[k - 1][b] <= endMin + EPS; });
        vec[k - 1] = endOpts[Math.floor(rng() * endOpts.length)];
        for (let j = k - 1; j > 0; j--) {
          const need = F[j][vec[j]] - unary[j][vec[j]];
          const opts = [0, 1].filter(function (b) {
            return F[j - 1][b] + pairw[j - 1][b][vec[j]] <= need + EPS;
          });
          vec[j - 1] = opts[Math.floor(rng() * opts.length)];
        }
        const sig = vec.join('');
        if (!seen.has(sig)) {
          seen.add(sig);
          fin.push({ vec, cost: vecCost(modelB, vec) });
        }
      }
    }
    return fin;
  }

  /* Reachability heuristic with multiplicity, across rows. A thread shifts at
   * most one column per row. Future demand cells of each color are covered
   * greedily by "virtual threads": once a thread covers a cell at (row q,
   * columns a..a+1) its future reach is [a-d, a+1+d] after d more rows, so it
   * can keep covering cells along its path. Cells no virtual thread can reach
   * claim a fresh real thread of that color; when supply runs out, penalty.
   * Catches both per-row multiplicity and distant blobs competing for the
   * same threads. */
  function coverPenalty(order, n, target, rDone, rows, horizon, minQ, off) {
    let penalty = 0;
    const maxQ = Math.min(horizon, rows - 1 - rDone);
    minQ = minQ || 1;
    if (maxQ < minQ) return 0;

    const supplyByColor = new Map(); // color -> [{col, used}]
    const wild = [];                  // unbound wildcard threads: any color
    for (let c = 0; c < n; c++) {
      if (order[c] == null) { wild.push({ col: c, used: false }); continue; }
      let arr = supplyByColor.get(order[c]);
      if (!arr) { arr = []; supplyByColor.set(order[c], arr); }
      arr.push({ col: c, used: false });
    }
    const virt = new Map(); // color -> [{lo, hi, lastQ}]

    for (let q = 1; q <= maxQ; q++) {
      const r = rDone + q;
      const rowT = target[r];
      if (!rowT) continue;
      const pairs = pairStarts(n, (r + (off || 0)) % 2);
      for (let m = 0; m < pairs.length; m++) {
        const t = rowT[m];
        if (t == null) continue;
        const a = pairs[m];
        // 1) reuse a virtual thread whose reachable interval touches {a, a+1}
        let threads = virt.get(t);
        if (!threads) { threads = []; virt.set(t, threads); }
        let bestI = -1, bestSlack = Infinity;
        for (let i = 0; i < threads.length; i++) {
          const th = threads[i];
          const d = q - th.lastQ;
          const lo = th.lo - d, hi = th.hi + d;
          if (a + 1 < lo || a > hi) continue;
          const slack = Math.min(Math.abs(a - lo), Math.abs(hi - (a + 1)));
          if (slack < bestSlack) { bestSlack = slack; bestI = i; }
        }
        if (bestI >= 0) {
          threads[bestI].lo = a; threads[bestI].hi = a + 1; threads[bestI].lastQ = q;
          continue;
        }
        // 2) claim the nearest unused real thread that can reach this cell;
        //    failing that, the nearest unused wildcard (it would be bound to t)
        const claim = function (supply) {
          let bestS = -1, bestDist = Infinity;
          if (!supply) return false;
          for (let i = 0; i < supply.length; i++) {
            const s = supply[i];
            if (s.used) continue;
            const dist = s.col < a ? a - s.col : (s.col > a + 1 ? s.col - (a + 1) : 0);
            if (dist <= q - 1 && dist < bestDist) { bestDist = dist; bestS = i; }
          }
          if (bestS < 0) return false;
          supply[bestS].used = true;
          threads.push({ lo: a, hi: a + 1, lastQ: q });
          return true;
        };
        if (claim(supplyByColor.get(t)) || claim(wild)) {
          // covered
        } else if (q >= minQ) {
          // an estimated real future error (0.9: slight discount for
          // heuristic imprecision); q < minQ cells are already counted
          // exactly by the chain-DP and deepLook terms
          penalty += 0.9;
        }
      }
    }
    return penalty;
  }

  /* Per-knot analysis for a row: which side must show, and the error if neither
   * thread matches the target. L/R are the colors AFTER any wildcard binding
   * this knot forces; `bind` says which incoming thread gets bound to the
   * target: 0 none, 1 left, 2 right, 3 either (both wildcards — the swap bit
   * decides, and both choices are crosses: see solveOnce). A wildcard is only
   * bound when the other thread cannot show the target, so it stays free for
   * as long as possible. */
  function rowInfo(order, rowTarget, pairs) {
    return pairs.map(function (c, j) {
      let L = order[c], R = order[c + 1];
      const t = (rowTarget && rowTarget[j] !== undefined) ? rowTarget[j] : null;
      let side, err = 0, dd = 0, bind = 0;
      if (t == null) side = 'free';
      else if (t === L) side = 'L';
      else if (t === R) side = 'R';
      else if (L == null && R == null) { side = 'L'; bind = 3; L = t; }
      else if (L == null) { side = 'L'; bind = 1; L = t; }
      else if (R == null) { side = 'R'; bind = 2; R = t; }
      else {
        err = 1;
        const dl = colorDist(t, L), dr = colorDist(t, R);
        dd = Math.min(dl, dr);
        side = dl <= dr ? 'L' : 'R';
      }
      return { L, R, t, side, err, dd, bind };
    });
  }

  /* Re-weave emitted knots from a concrete starting order: shown colors and
   * per-row orders with every wildcard resolved. */
  function replay(strands, knotsIn) {
    let order = strands.slice();
    const orders = [order.slice()];
    const knots = knotsIn.map(function (row) {
      const next = order.slice();
      const out = row.map(function (k) {
        const c = k.col, L = order[c], R = order[c + 1];
        const shown = (k.type === 'f' || k.type === 'fb') ? L : R;
        if (k.type === 'f' || k.type === 'b') { next[c] = R; next[c + 1] = L; }
        return { col: c, type: k.type, shown, target: k.target, err: k.err };
      });
      order = next;
      orders.push(order.slice());
      return out;
    });
    return { knots, orders, endOrder: order };
  }

  /* Color for wildcards the design never asked for: the most painted color,
   * else the first fixed strand, else cream. */
  function pickDefaultColor(strands, target) {
    const count = new Map();
    let best = null, bestN = 0;
    for (const row of target || []) {
      if (!row) continue;
      for (const t of row) {
        if (t == null) continue;
        const k = (count.get(t) || 0) + 1;
        count.set(t, k);
        if (k > bestN) { bestN = k; best = t; }
      }
    }
    if (best != null) return best;
    for (const c of strands) if (c != null) return c;
    return '#f7f3eb';
  }

  /* Second-order lookahead: given the order entering row rNext, the best
   * achievable penalty of (row rNext errors are fixed) + (row rNext+1
   * reachability under the best rNext swap vector). One chain DP. */
  function deepLook(order, n, target, rNext, rows, off) {
    if (rNext >= rows) return 0;
    const pairs = pairStarts(n, (rNext + (off || 0)) % 2);
    const info = rowInfo(order, target[rNext], pairs);
    const hasNext = rNext + 1 < rows;
    const nextPairs = hasNext ? pairStarts(n, (rNext + 1 + (off || 0)) % 2) : [];
    const nextTargets = hasNext ? (target[rNext + 1] || null) : null;
    const best = kBestSwaps(order, pairs, info, nextPairs, nextTargets, 1, 0, null);
    return best.length ? best[0].cost : 0;
  }

  /* strands: array of hex colors (start order, left to right); null = wildcard
   *          strand whose color the solver picks from the design
   * rows:    number of knot rows
   * target:  target[r][j] = hex color or null (solver's choice)
   * Returns { strands, knots, orders, errors, endOrder, repeats }
   *   strands      = resolved starting colors (wildcards filled in)
   *   knots[r][j]  = { col, type: 'f'|'b'|'fb'|'bf', shown, target, err }
   *   orders[r]    = colors left-to-right BEFORE row r (orders[rows] = final)
   */
  function solveOnce(opts) {
    const strands = opts.strands, rows = opts.rows, target = opts.target;
    const beamWidth = opts.beamWidth || 96, branchK = opts.branchK || 8;
    const samples = opts.samples === undefined ? 10 : opts.samples;
    const horizon = opts.horizon || 12;
    const n = strands.length;
    const off = opts.parityOffset || 0;
    const start = strands.map(function (c) { return c == null ? null : c; });
    const defaultColor = opts.defaultColor || pickDefaultColor(start, target);
    const ids0 = [];
    for (let i = 0; i < n; i++) ids0.push(i);
    const rng = mulberry32(opts.seed === undefined ? 0x5EED : opts.seed);

    // errors dominate; then estimated future errors; then color-mismatch
    // distance and bounce count as commensurate small terms
    const score = function (s) {
      return s.err + s.look + s.bounce * BOUNCE_W + s.dist / 2000;
    };

    // order: colors per column (null = unbound wildcard); ids: which starting
    // strand sits in each column; bound: color per starting strand so far
    let beam = [{ order: start, ids: ids0, bound: start.slice(),
                  err: 0, dist: 0, look: 0, bounce: 0, rowsOut: [] }];

    for (let r = 0; r < rows; r++) {
      const pairs = pairStarts(n, (r + off) % 2);
      const hasNext = r + 1 < rows;
      const nextPairs = hasNext ? pairStarts(n, (r + 1 + off) % 2) : [];
      const nextTargets = hasNext ? (target[r + 1] || null) : null;
      const rowTarget = target[r] || [];
      const cands = new Map();

      for (const st of beam) {
        const info = rowInfo(st.order, rowTarget, pairs);
        let rowErr = 0, rowDist = 0;
        for (const i of info) { rowErr += i.err; rowDist += i.dd; }

        const vecs = kBestSwaps(st.order, pairs, info, nextPairs, nextTargets, branchK, samples, rng);
        for (const v of vecs) {
          const order = st.order.slice(), ids = st.ids.slice();
          let bound = st.bound; // copied on first binding
          let rowBounce = 0;
          const knots = pairs.map(function (c, j) {
            const inf = info[j];
            let s = v.vec[j];
            let type, shown;
            if (inf.bind === 3) {
              // two wildcards: the swap bit says which side the new color
              // lands on, and either way a straight cross gets it there
              // (bind left + forward, or bind right + backward)
              bound = bound === st.bound ? bound.slice() : bound;
              bound[ids[s ? c : c + 1]] = inf.t;
              type = s ? 'f' : 'b';
              shown = inf.t;
              order[c] = s ? null : inf.t;
              order[c + 1] = s ? inf.t : null;
              s = 1;
            } else {
              if (inf.bind) {
                bound = bound === st.bound ? bound.slice() : bound;
                bound[ids[inf.bind === 1 ? c : c + 1]] = inf.t;
              }
              if (inf.L === inf.R) s = 1; // identical colors: canonical forward knot
              else if (!s) rowBounce++;
              const useL = inf.side !== 'R';
              type = useL ? (s ? 'f' : 'fb') : (s ? 'b' : 'bf');
              shown = useL ? inf.L : inf.R;
              // written even without a swap: a binding may have just given
              // one of these columns its color
              order[c] = s ? inf.R : inf.L;
              order[c + 1] = s ? inf.L : inf.R;
            }
            if (s) { const tmp = ids[c]; ids[c] = ids[c + 1]; ids[c + 1] = tmp; }
            return { col: c, type, shown, target: inf.t, err: inf.err };
          });
          const key = order.join('|');
          const cand = {
            order, ids, bound, err: st.err + rowErr, dist: st.dist + rowDist,
            look: v.cost, // cheap score now; deep score for survivors below
            bounce: st.bounce + rowBounce,
            rowsOut: st.rowsOut.concat([knots]),
          };
          const prev = cands.get(key);
          if (!prev || score(cand) < score(prev) ||
              (score(cand) === score(prev) && cand.dist < prev.dist)) {
            cands.set(key, cand);
          }
        }
      }

      // Rank by err + estimated future errors so the beam can eat one error
      // now to save several later; accumulated bounces ride along at BOUNCE_W
      // (color-mismatch distance at pen()'s dist/2000 scale) so tightness and
      // match quality break ties without ever outranking a real error.
      const byScore = function (a, b) {
        return score(a) - score(b) || a.dist - b.dist;
      };
      // jitter breaks ties among equal cheap scores so the pre-filter cut is
      // not systematically biased toward early-enumerated swap vectors
      const byCheap = function (a, b) {
        return score(a) - score(b) || a.dist - b.dist || a.jit - b.jit;
      };
      const all = Array.from(cands.values());
      for (const c of all) c.jit = rng();
      let pool = all.sort(byCheap).slice(0, beamWidth * 3);
      for (const cand of pool) {
        cand.look += deepLook(cand.order, n, target, r + 1, rows, off) +
                     coverPenalty(cand.order, n, target, r, rows, horizon, 3, off);
      }
      beam = pool.sort(byScore).slice(0, beamWidth);
    }

    // resolve each survivor's starting order (wildcards never demanded get
    // the default color) so the repeat preference compares real orders
    for (const st of beam) {
      st.strands = st.bound.map(function (c) { return c == null ? defaultColor : c; });
      const endKey = st.ids.map(function (i) { return st.strands[i]; }).join('|');
      st.repeats = endKey === st.strands.join('|');
    }
    beam.sort(function (a, b) {
      return a.err - b.err || a.dist - b.dist || a.bounce - b.bounce ||
        (b.repeats ? 1 : 0) - (a.repeats ? 1 : 0);
    });
    const best = beam[0];
    const rp = replay(best.strands, best.rowsOut);
    return {
      strands: best.strands,
      knots: rp.knots,
      orders: rp.orders,
      errors: best.err,
      bounces: best.bounce,
      endOrder: rp.endOrder,
      repeats: best.repeats,
    };
  }

  /* Bounce polish: the achieved shown-color grid of any solution is weavable
   * by construction, so re-solve against it fully specified, with a WIDE beam
   * and the long-range cover heuristic off. Many trajectories tie at "perfect
   * for the next two rows" and only differ in bounces needed far later — a
   * normal-width beam slices those ties arbitrarily, so width is what buys
   * global tightness. Affordable when the bracelet is narrow (the pen-0
   * constraint of a fully-specified feasible grid prunes parents hard);
   * wider bracelets keep the local diagonal bias only. Adopt only a strictly
   * tighter exact reproduction, with targets/errors remapped to the ORIGINAL
   * painting. */
  function polish(best, opts, t0, budget) {
    if (best.bounces === 0 || opts.strands.length > 14) return best;
    const achieved = best.knots.map(function (row) {
      return row.map(function (k) { return k.shown; });
    });
    const target = opts.target;
    let out = best;
    for (const bw of [512, 2048]) {
      if (Date.now() - t0 > budget) break;
      const p = solveOnce(Object.assign({}, opts,
        { strands: best.strands, target: achieved, horizon: 0, beamWidth: bw }));
      if (p.errors !== 0 || p.bounces >= out.bounces) continue;
      const knots = p.knots.map(function (row, r) {
        return row.map(function (k, j) {
          const t = (target[r] && target[r][j] !== undefined) ? target[r][j] : null;
          return { col: k.col, type: k.type, shown: k.shown, target: t,
                   err: t != null && k.shown !== t ? 1 : 0 };
        });
      });
      out = {
        strands: best.strands,
        knots,
        orders: p.orders,
        errors: best.errors, // identical achieved grid ⇒ identical mismatches
        bounces: p.bounces,
        endOrder: p.endOrder,
        repeats: p.repeats,
      };
      if (out.bounces === 0) break;
    }
    return out;
  }

  /* Public entry: quick pass first; if any cell failed, escalating retries
   * with wider beams and fresh seeds. effort: 'fast' (while dragging) skips
   * retries entirely. */
  function solve(opts) {
    const t0 = Date.now();
    const budget = opts.budgetMs || 6000;
    opts = Object.assign({}, opts,
      { defaultColor: opts.defaultColor || pickDefaultColor(opts.strands, opts.target) });
    let best = solveOnce(opts);
    if (opts.effort === 'fast') return best;
    if (best.errors === 0) return polish(best, opts, t0, budget);
    // narrow bracelets afford much wider beams; wide ones lean on seeds
    const ladder = opts.strands.length <= 14 ? [
      { beamWidth: 512, branchK: 12, samples: 24, horizon: 16, seed: 0xBEAD5 },
      { beamWidth: 1024, branchK: 14, samples: 40, horizon: 20, seed: 7 },
    ] : [
      { beamWidth: 192, branchK: 12, samples: 24, horizon: 16, seed: 0xBEAD5 },
      { beamWidth: 256, branchK: 14, samples: 40, horizon: 20, seed: 7 },
      { beamWidth: 256, branchK: 14, samples: 40, horizon: 20, seed: 424242 },
    ];
    for (const step of ladder) {
      if (Date.now() - t0 > budget) break;
      const retry = solveOnce(Object.assign({}, opts, step));
      if (retry.errors < best.errors ||
          (retry.errors === best.errors && retry.bounces < best.bounces)) best = retry;
      if (best.errors === 0) break;
    }

    /* Suffix repair: lock the clean prefix, re-solve from just above the
     * first error with the full beam focused on the shorter remainder. */
    let guard = 0;
    while (best.errors > 0 && guard++ < 6 && Date.now() - t0 < budget) {
      let rE = -1;
      for (let r = 0; r < best.knots.length && rE < 0; r++) {
        for (const k of best.knots[r]) if (k.err) { rE = r; break; }
      }
      if (rE < 0) break;
      const rStart = Math.max(0, rE - 14);
      if (rStart === 0) break; // full solves already tried this
      let prefixErr = 0;
      for (let r = 0; r < rStart; r++) for (const k of best.knots[r]) if (k.err) prefixErr++;
      const sub = solveOnce({
        strands: best.orders[rStart],
        rows: opts.rows - rStart,
        target: opts.target.slice(rStart),
        parityOffset: (rStart + (opts.parityOffset || 0)) % 2,
        beamWidth: 256, branchK: 14, samples: 40, horizon: 20,
        seed: 1000 + guard * 77,
      });
      if (prefixErr + sub.errors < best.errors) {
        const startKey = best.strands.join('|');
        const knots = best.knots.slice(0, rStart).concat(sub.knots);
        best = {
          strands: best.strands,
          knots,
          orders: best.orders.slice(0, rStart).concat(sub.orders),
          errors: prefixErr + sub.errors,
          bounces: countBounces(knots),
          endOrder: sub.endOrder,
          repeats: sub.endOrder.join('|') === startKey,
        };
      } else break;
    }
    return polish(best, opts, t0, budget);
  }

  return { solve, solveOnce, pairStarts, colorDist, replay };
});
