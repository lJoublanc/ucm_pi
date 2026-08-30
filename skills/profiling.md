---
name: profiling
description: Read and interpret UCM profiler output from `run.profiled` / `run.profiled.full` — .ticks and .wakeup files, self vs inclusive ticks, continuation nesting, per-symbol FFI labels. Use whenever profiling a Unison program, deciding why something is slow, comparing two implementations, or when a profile seems to contradict itself. Covers what the profiler cannot see, and the measurements to do instead.
---

# Profiling Unison programs with UCM

The short version: **UCM's profiler measures interpreter steps, not time.** Its
output is very good for locating *where Unison code is doing a lot of work*, and
systematically misleading for *how much wall time anything costs* — especially
anything involving foreign calls, blocking IO, or big data loads. Everything
below follows from that one fact.

## Commands

```
run.profiled      mymain args...          # inline summary, top ~25 functions
run.profiled.full mymain outfile args...  # full record written to outfile
```

`run.profiled` filters to the 25 most expensive functions. Use `.full` for
anything you intend to analyse. The term must be a delayed thunk
(`'{IO, Exception} a`); if it typechecks to a plain value you'll get
"expected the expression to be delayed" — wrap the body in `do`.

Output file format is chosen by extension:

* `.ticks` or `.folded` → collapsed stacks, one `stack<space>count` per line,
  directly consumable by `flamegraph.pl`.
* anything else → plain text: a "Hot Spots" table plus an
  inherited/local call tree.

**A second file is always written: `<outfile>.wakeup`.** See
[The .wakeup file](#the-wakeup-file).

## Tick file anatomy

```
#jao8jugedg;my.Main.train;cblas.run;cblas.compile.dense;compile.gemm 18
└── root ──┘ └──────────── ;-separated stack, outermost first ─────────┘  └ ticks
```

* The **root frame is the hash of the profiled term**. It changes when the code
  changes, so strip it before comparing two profiles.
* **Parents carry `0`; only leaves carry samples.** So a line with a trailing
  `0` is just scaffolding, and the file's total is the sum of the last column.
* Naming conventions you'll see:
  * `foo$go` — a local recursive helper (`go` loops, `handler$go`, …)
  * `foo$Lambda0`, `#abc123$Lambda1` — anonymous lambdas. **The hash/number
    differs per build and per branch**, so these never line up across two
    profiles; collapse them into one bucket when diffing.
  * `##jumpCont`, `##force` — runtime plumbing.
  * `##<library path>$<symbol>` — a foreign call, e.g.
    `##/usr/lib/.../libblas.so$cblas_dgemm`.

Quick sanity numbers for a file:

```sh
python3 -c "
t=0;n=0
for ln in open('out.ticks'):
    st,_,c=ln.strip().rpartition(' ')
    try: t+=int(c); n+=1
    except: pass
print('ticks',t,'stacks',n)"
```

## Reading rules

### 1. Absence of a frame is not evidence it never ran

A tick file records only the stacks that were *sampled*. A function called a
thousand times but never caught by a tick leaves no line at all. Never conclude
"X was never called" from a profile — read the source or count the calls.

### 2. Nesting is continuation nesting, not call nesting

This is the most common misreading. An ability handler resumes like:

```unison
{ op x -> cont } -> handle cont (op x) with go
```

so the **entire rest of the program runs inside the frame of whichever request
was raised**. A wide frame therefore means "this operation was raised, and here
is everything that happened afterwards", *not* "this operation cost that much".

In practice you'll see one or two frames with enormous *inclusive* weight that
are just the entry point of a handler chain, and a bare `>>` sitting above most
of the program. Filter on **self** ticks (last frame of the stack) to find real
cost; treat inclusive numbers as a containment hierarchy only.

### 3. Foreign calls are under-sampled, roughly once per call

The runtime arms a timer (`registerTimeout tm 100`, i.e. 100 µs) whose callback
*tries* to enqueue a tick, but ticks are **consumed only at interpreter comb
boundaries** (`checkTicker`), and the enqueue is deliberately non-blocking: "if
something is already there, a second tick just won't happen." Two multipliers
on the nominal 10 000/s therefore stack up before you start — the callback can
only fire when the scheduler gets it, and it is dropped unless the program has
crossed a comb boundary to pick it up. Any stretch in which the program is not
crossing those boundaries — inside a foreign call, blocked on IO, in the GC —
loses ticks wholesale.

Measured on a 4-core Linux box, in a single run of three synthetic burns:

| burn | wall time | ticks | **ticks/sec** |
|---|---|---|---|
| pure interpreter loop | 2.03 s | 3705 | **1826** |
| 200 × 600³ `dgemm` | 2.78 s | 1718 | **619** |
| 20000 × 24³ `dgemm` | 1.89 s | 2820 | 1494 |

Even the pure-interpreter case sampled at ~1 826/s, not the nominal 10 000/s,
so treat the absolute rate as machine- and workload-dependent. What matters is
the **ratio**: the same tick is worth **3× more wall time** in the
interpreter-bound case than in the foreign-call-bound case. Percentage shares
are therefore not comparable across kinds of work, and an FFI-dominated program
will look like it spends all its time in Unison glue.

You can confirm the per-call rather than per-time behaviour: 200 big gemms
yielded 236 foreign-call ticks; 50 of the same gemms yielded 66. The count
tracks **calls**, not seconds — big and small gemms each accrue ≈1 tick.

**Corollary: if your program's real cost is in FFI or blocking IO, the profile
will not show it. Calibrate or measure with wall time instead.**

### 4. The bug that conflates FFI symbol names

**[unisonweb/unison#6261 — "Profiler conflates FFI symbol names"](https://github.com/unisonweb/unison/issues/6261)**
(open, author lJoublanc).

Every dynamically-loaded foreign function is given the **same comb index**
(`dummyCix = CIx dummyRef maxBound 0`). Sample paths are keyed by that index,
and the index→name map is built with a **left-biased** `M.union`, so the
*first* symbol name ever seen for the index wins for the whole run:

```haskell
cixToPair (CIx r i _) = (i, r)     -- path keyed by numeric comb index
addPath wait (fst <$> cmbs) trie   -- only the index reaches the trie
M.union refs (M.fromList cmbs)     -- left-biased: first name for an index wins
```

Consequence: **all foreign time in a run may be attributed to whichever routine
happened to be sampled first.** A program making heavy use of `dcopy`, `dgemm`,
`dscal` and `daxpy` can show only `cblas_dcopy`. The tempting wrong conclusion
("the multiplications disappeared, only copies are happening") is exactly the
bug. **Only the aggregate time inside foreign calls is trustworthy — not the
per-symbol breakdown.**

Cross-check symbol-level claims by counting calls in the source, or by wall
timing a region. Note also that per-routine names *can* appear distinct when
each routine is a separate top-level binding; the point is that you cannot rely
on either pattern.

### 5. The `.wakeup` file

`<outfile>.wakeup` holds the subset of samples flagged *post-wakeup* — a tick
that arrived while a previous tick was still unconsumed, i.e. the thread wasn't
crossing comb boundaries at the expected rate. (In the text output this appears
as a separate "Post-wakeup Profile" section, or "Threads never missed ticks"
when empty.) It's a cheap alarm bell:

| profile | main ticks | wakeup ticks |
|---|---|---|
| pure interpreter loop | 3705 | 1 |
| big-gemm burn | 1718 | 202 |

A non-trivial wakeup count means a meaningful slice of the run happened **outside
the interpreter** — foreign calls, blocking IO, GC, thread starvation — and that
the main profile's shares are therefore distorted in the direction described
above. Always look at the ratio before interpreting.

## Before you profile: do this instead, first

### Calibrate the tick rate

Write two throwaway burns of a couple of seconds each — one dominated by
interpreter work, one dominated by the foreign/IO work you care about — profile
both, and compute ticks/sec. If they differ, you know the profile can't be read
as wall time and you switch to wall-clock ablation for the rest of the session.

### Separate setup from the thing you want to measure

The single most valuable measurement of a recent session was not a profile at
all. A benchmark reported five "backends" at 27–57 s each, implying big
differences between libraries. A phase ablation, timing each stage in
isolation, showed:

| stage | wall |
|---|---|
| read a 47 MB file into `Bytes` | 0.011 s |
| `+ Bytes.toList` | 6.4 s |
| `+ List.map` to `[Float]` | **26.3 s** |
| full library run, inclusive of the above | 28.7 s |
| same, with data preloaded outside the timer | **0.6 s** |

~97 % of the "benchmark" was a data-loading helper materialising a
**47,040,000-element** list to serve a model that consumed 39,200 elements. All
five "backends" were measuring the same pure-Unison list conversion. The
profile confirmed it mechanically (`readImages` = 96.7 % of ticks) but the
ablation explained it.

Practical rules:

* **Never profile a program whose root includes unbounded setup.** Build a
  compute-only variant that takes the data pre-loaded.
* Read only what you consume. `List.take n` over a lazily-produced list still
  forces the whole list if the producer is strict — slice at the `Bytes`/array
  level instead.
* Don't put forcing tricks inside a timed region. `List.size bigList` as a way
  "to make sure it's evaluated" added seconds to one measurement and produced
  a number inconsistent with the others.

### Prefer scaling probes for structural questions

Is per-iteration cost constant, or does it grow with iteration count (accumulated
handler depth, a memo map that never prunes, retained buffers)? Time the workload
at 10/20/40/80 iterations:

```
ep=010  309 ms   ep=020  422 ms   ep=040  780 ms   ep=080 1472 ms
```

Marginal cost ≈ 17 ms/epoch (consecutive deltas 11.4, 17.9, 17.3 — the first is
warm-up noise) against ≈ 110 ms of fixed cost by least squares. That is
**linear**, and it was not obvious beforehand: the code contains a handler that
re-wraps its continuation on every operation, which is the classic shape for
quadratic behaviour. That single run refuted the suspicion for this workload and
redirected the investigation to the ~110 ms fixed cost. Had it been quadratic,
doubling iterations would have quadrupled time.

Report both the slope *and* the intercept. A fixed cost that dominates at small
iteration counts is a different bug from a growing marginal cost, and only the
intercept shows it.

Put a safety valve in scaling probes. A quadratic you suspect but haven't proved
will run for an hour at 160 iterations; bail out if any stage exceeds a threshold.

### Force what you mean to measure, and verify forcing matters

Unison is call-by-value, but `ignore !prog` where `prog` produces a large
structure can still leave work undone if the consumer is lazy. Fold over the
result and `printLine` something derived from it, then run a
*forced vs unforced* control once. If the two agree, laziness isn't hiding work
and you can use the cheaper form thereafter.

### Memory

`run.profiled.full` retains sampled stacks, and profiles of long-running
programs get large (11 MB / 4000 distinct stacks for a 28 s run; stack depth
reached 786 frames). Profiling while holding multi-million-element lists across
several trials OOM'd a 16 GB machine. Mitigations: preload once and reuse, drop
the biggest list before the next trial, cut trial count, and prefer a narrowed
profile target over the whole application.

## A summariser is worth having

`run.profiled.full`'s text output is fixed-format. A ~100-line script gets you
the four views that actually answer questions — all read off the same parse:

1. **self ticks**, top N, per profile, side by side (strip the root hash frame;
   collapse `$Lambda`/hash frames)
2. **inclusive ticks**, top N — containment only, remember rule 2
3. **foreign frames only** — grep for `##`-prefixed frames to get aggregate
   time in libraries (aggregate is trustworthy, per-symbol is not: #6261)
4. **bucketed shares** — classify each stack by first matching keyword
   (`NatMap`, `murmurHash`, `compile.`, `transpose`, …) to ask "how much of the
   compute phase is bookkeeping?" and get an answer in one line.

Two extras that paid for themselves:

* **max / tick-weighted stack depth** — a proxy for handler-nesting cost; we saw
  786 frames deep versus 9 for a comparable alternative.
* **depth histogram of self ticks** — if ticks concentrate at depth ≥ 40, your
  cost is buried in a continuation chain and the flat "top functions" table is
  telling you little.

## Interpreting results: a checklist

1. Is the profile dominated by setup (file parsing, list building, network)?
   → Hoist it out and re-profile. Do not draw conclusions from this one.
2. Is the `.wakeup`/main tick ratio non-trivial? → Foreign/blocking time is
   material and the shares are skewed; switch to wall-clock ablation.
3. Do the top self ticks sit inside handler-resumption frames (`$go`, `$Lambda0`,
   a bare `>>`)? → Continuation nesting. Look at what is *near the leaves*, not
   the widest frame.
4. Is a foreign symbol suspiciously dominant or suspiciously absent? → #6261;
   treat only the aggregate as real.
5. Are you comparing two profiles? → Strip root hashes, collapse lambda frames,
   and compare **shares** not absolute tick counts (the rates differ).
6. Is any conclusion resting on a tick percentage alone? → Back it with a wall
   timing or a scaling probe before acting on it.

## Worked example of a wrong reading, corrected

Observed in a profile of a linear-algebra library: `materializeScale` 28 % of
compute ticks, `List.transpose` 6 %, `NatMap` bookkeeping 44 %, foreign calls
1.8 %. Read as wall time this says "the compiler's environment map is the
bottleneck".

Correct interpretation, after calibrating (ticks/sec 3× lower on FFI-bound
code) and then measuring constructors directly with wall time:

| probe | time for 39,200 elements |
|---|---|
| `matrix` (transpose + join + per-element `setAt` + `fromPinned`) | 94 ms |
| `vector` (per-element `setAt` + `fromPinned`) | 44 ms |
| N gemms of the same operands, marginal cost per gemm | ~0 ms |

The real cost was **one foreign write per element** in the leaf constructor —
invisible in the profile because foreign-call time is under-sampled, and
because the writes appear as a few thousand separate cheap frames spread across
`toOps$Lambda1` / `List.foreach` / `setAt` rather than one hot function. The
NatMap bookkeeping was genuinely present, but an order of magnitude behind.

Two transferable lessons:

* **Cost spread thinly across many cheap operations is invisible to a
  step-counting profiler.** Count the operations (per-element? per-node?) from
  the source.
* **A profile tells you where to look; a targeted timing experiment tells you
  what is true.** Budget for one ablation per surprising profile finding.

## The "zero-copy constructor" trap

A fast path is often documented as avoiding a copy — "constructs a matrix from a
pinned byte array; avoids copying buffer data on ingestion". Believing that
wording without checking the producer is how sessions go wrong, for two reasons.

**Switching to such a constructor only *relocates* the cost.** The caller must
still populate the buffer from whatever it holds — usually a list of scalars.
If the only available fill primitive is a per-element write, that loop is
unchanged and its cost still sits inside the timed region. Ask not "is the copy
gone?" but "what is the element count of every remaining loop, and how many
foreign calls does each element make?"

**"No copy" does not mean "no work"** — a single ingestion step can still do
O (bytes) work for its own reasons, e.g. hashing the buffer's contents to key a
common-subexpression table. So *measure it* rather than reasoning from the
wording. The control that settles it is the constructor applied to an **unfilled
buffer of the same size**, which isolates ingestion from the fill:

| probe | what it contains | wall |
|---|---|---|
| `matrix ROWS` | transpose + join + per-elem fill + `fromPinned` | 84 ms |
| `vector DATA` | per-elem fill + `fromPinned` | 80 ms |
| `fromPinned` on an **empty** buffer | ingestion alone | **0.7–3 ms** |
| `pinnedByteArray` of the same size | allocation alone | 0.004 ms |

Ingestion is ~1–3 % of the cost, so ~96 % of the 84 ms is the per-element fill
(39,200 elements ≈ 2 µs each). Two conclusions that were *not* guessable:

* Switching to `fromPinned` saves ~0 — the fill just moves to the caller, and
  the caller faces the same per-element write. Only a loader that produces the
  buffer format directly removes the loop entirely.
* Suspecting ingestion ("it must be hashing the contents") and suspecting the
  fill are equally plausible a priori; the empty-buffer control distinguishes
  them in one run. The hypothesis was worth having — and worth killing.

Beware single-shot variance when doing this decomposition: a `vector` fill
measured 44 ms in one run and 80 ms in another with identical element counts,
because the loops are allocation-heavy and GC state differs by what ran before.
Confirm any sub-step number by repeating the operation a known number of
times and taking the slope (1x vs 30x), so fixed overhead and GC state drop out.
