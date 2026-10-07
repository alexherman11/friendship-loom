# Friendship Loom

Inspired by my roommate, I got into making simple friendship bracelets for my friends, though initially I 
was impressed and intimidated by the complexity of designs that could be found on sites like 
friendship-bracelets.net (due likely to their simple and useful knots->pattern solver shown below).

<img width="468" height="474" alt="image" src="https://github.com/user-attachments/assets/d740b3d8-113a-4feb-b3a6-85d4d6f6e9c2" />

However, when I started an ambitious project of 19 strands and wanted to create arbitrary
pixel art, I realized there was a gap between pixel art -> weaving pattern. Complex patterns, i realized, 
do not have obvious ways of weaving them, though undoubtedly with lots of experience or tinkering you could 
generate anything manually. However this felt like a blocker and I created Friendship Loom.

<img width="1019" height="742" alt="image" src="https://github.com/user-attachments/assets/5900901f-0883-44e9-9906-66674edc45d6" />

With Claude, I designed this friendly solver which can take any artwork and starting strand
arrangement, and convert it into a pattern that is easy to read. It prefers crossing knots
and patterns that end up the same as they started. It is currently up for anyone to use for
free at 

https://friendship-loom-production.up.railway.app/


Draw pixel art (or stamp ASCII art), and get a
[friendship-bracelets.net](https://friendship-bracelets.net)-style knot diagram
that weaves it — for up to 30 starting strands.

## Run it

Any static server works (it's plain HTML/CSS/JS, no build step):

```
npx http-server . -p 8471
# then open http://localhost:8471
```

Opening `index.html` directly from disk also works.

Run the solver test suite with `node test.js`.

## How to use

1. **Threads** — set the strand count and click the bobbins to recolor each
   starting strand (left to right, the order they hang before row 1). Or set
   bobbins to **auto** (the dashed chip in the color picker, or **All auto**):
   the solver then picks their colors and effectively the starting order from
   your drawing, so you never have to tinker with the order by hand. Auto
   bobbins show the solver's pick faded with a `?`; **Lock in solved** turns
   those picks into fixed colors.
2. **Paint** — brush/fill knots on the canvas with any palette color. The
   palette holds the bobbin colors plus anything already in the drawing; use
   **+** to paint with a color no bobbin has yet (an auto bobbin will take it).
   Unpainted cells are *auto*: the solver weaves whatever is convenient there
   (shown as a faint ghost). Or click **ASCII art** to stamp text art onto the
   canvas.
3. **Read the result** — the right panel shows the woven look and the knot
   diagram: each circle is one knot, its fill is the color that shows, and the
   arrow is the knot to tie. Cells the solver cannot reach get a red stitch and
   the nearest achievable color.
4. **Export** — diagram as SVG/PNG, row-by-row text instructions, or the whole
   pattern as JSON (Save/Load).

## Weaving model

A "normal" pattern is a brick-wall lattice: odd rows knot strand pairs
(1,2)(3,4)…, even rows knot (2,3)(4,5)…, edge strands pass straight down.
Threads keep their color forever; only their positions change. Four knots
exist, and they're exactly "cross" or "bounce", showing one side's color:

| knot | arrow | threads | color shown |
|------|-------|---------|-------------|
| F  forward           | ↘ straight | swap    | left thread  |
| B  backward          | ↙ straight | swap    | right thread |
| FB forward-backward  | ↘ hook     | stay    | left thread  |
| BF backward-forward  | ↙ hook     | stay    | right thread |

## Solver

Key structure: the painted pixel only forces *which incoming thread's color
shows* (left or right) — legality never depends on the knot choice beyond
that. The remaining freedom is the swap bit, which only affects future rows.

- **Per row**, the effect of swap bits on the *next* row's satisfiability
  decomposes over adjacent knots — a chain — so the best swap vectors are
  found exactly with a k-best dynamic program (exhaustive enumeration when the
  row is narrow), plus diverse optimal vectors sampled from the DP table.
- **Across rows**, a beam search ranks states by
  `errors so far + estimated future errors`, where the estimate combines the
  exact next-row chain cost, an exact second-row DP, and a longer-range
  *path-cover* heuristic: threads move at most one column per row, so future
  demand cells are matched to virtual threads with evolving reachable
  intervals — catching both "color out of range" and "two blobs, one thread"
  failures many rows ahead.
- If any cell still fails, an escalation ladder retries with wider beams and
  fresh seeds, then a **suffix repair** locks the clean prefix and re-solves
  from just above the first error.
- **Auto strands**: a starting strand given as `null` is a wildcard. Inside the
  beam search it is a joker — the lookahead treats it as matching any color —
  and it is *bound* lazily, the first time a painted cell needs a color that
  neither incoming thread has. Thread identities are tracked through every
  swap so the binding lands on the right starting bobbin, and when both
  threads of a knot are wildcards the swap bit decides which side the new
  color lands on (both choices are straight crosses). Wildcards the design
  never asks for take the most-painted color. The result's `strands` is the
  resolved starting order; it is replayed so every intermediate order and
  shown color is concrete.
- **Diagonal preference**: bracelets weave tighter with straight crosses than
  with bounces ("double backs"), so every bounce pays a small penalty —
  calibrated so a full wall of bounces still costs less than one wrong pixel;
  correctness always wins. The deterministic k-best DP runs on cross-biased
  costs while the random samples stay unbiased (biasing both starves the beam
  of routing diversity). A final **bounce polish** re-solves the achieved grid
  (weavable by construction) with a much wider beam for bracelets up to 14
  strands, where the many trajectories that tie over a two-row horizon but
  differ in far-future bounces can all be kept and compared.

Measured behavior (`test.js`): exact reproduction of every weavable pattern up
to 20 strands, also when every starting strand is left auto; patterns woven with only crossing knots come back with **zero**
bounces (≤ 12 strands); on 30-strand *uniformly random* targets (an
adversarial case unlike any drawing) ≥99.7% of knots; interactive pass on
30×60 in under a second, typical drawings in tens of milliseconds. Genuinely
impossible pixels are flagged rather than silently absorbed, and the solver
prefers solutions whose final strand order matches the start, so the pattern
repeats seamlessly.
