---
name: unison
description: Write Unison code and interact with a UCM (Unison Codebase Manager) codebase. Use whenever editing .u scratch files, adding/updating definitions, installing libraries, running tests via `test>` watch expressions or `unison_test`, or querying definitions. Covers the scratch-file workflow and the fact that definitions live in the codebase, not in files.
---

# Unison + UCM

## The one rule that trips up file-based agents

**Definitions live in the content-addressed codebase, not in files.** `grep`,
`read`, and `find` (the built-in ones) cannot see them. To inspect existing
code use `unison_view` (source) and `unison_find` (search by name or type).
Only *scratch* files (`*.u`) are real files you edit.

## Workflow

1. Write/modify definitions in a scratch file (e.g. `scratch.u`) with `write`/`edit`.
   Editing a `.u` file auto-runs a typecheck — read the appended diagnostics.
2. Fix until it typechecks. For inline snippets, call `unison_typecheck`.
3. **Test without committing** (see [Testing](#testing)): add a `test>` watch
   expression in the scratch file and re-typecheck. The compiled test results
   appear in the typecheck output. Iterate until green.
4. Only commit with `unison_update` if the user wants the change in the codebase.
   `unison_update` typechecks **and** adds/updates in one step.

Do not call `unison_typecheck` and then `unison_update` separately for the same
code — `unison_update` already typechecks. Fewer calls = fewer tokens.

## Testing

The scratch-file **watch expression** is the preferred way to run tests. It
requires no commit; the test is evaluated as part of the typecheck.

### Pure tests via `test>` watch expressions

A test that returns `[Test]` (a list of `Test`) can be written as a `test>`
watch expression in the scratch file:

```unison
test> Nat.tests.props = test.verify do
  Each.repeat 100
  n = Random.natIn 0 1000
  m = Random.natIn 0 1000
  labeled "addition is commutative" do
    ensureEqual (n + m) (m + n)
```

This is **not** committed by the file save — but if the user later runs
`unison_update` (or `add` inside UCM), the term *is* added to the codebase:

- The bare `test> <expr> =` form adds an **anonymous** term.
- The inline form `test> mynamedtestterm = <expr>` adds a **named** term, so
  use it when you want the test to be discoverable after commit (e.g. for
  `unison_test` / `unison_find`).

Either way, until commit the test results surface in the typecheck output. This
is the cleanest loop: edit → typecheck → see results → iterate, with no
codebase churn.

### IO tests via `run`

For tests that must perform `IO` (FFI, file I/O, etc.), **prefer `run` over
`test.io`**. Reasons:

- `run` will warn you against stale changes (an updated scratch file that has
  not been committed to the codebase). `test.io` will silently use the old
  version.
- `test.io` currently has a known bug
  ([unisonweb/unison#5448](https://github.com/unisonweb/unison/issues/5448))
  that crashes when run on a term that exists only in the scratch file, not
  yet in the codebase. `run` is more robust.

If `run` reports a type error that the term is `'{IO, Exception} result` but
only `[Result]` exists, you've found a `[Result]` value (not a thunk) — use
the `unison_test` flow with a `test>` watch instead.

### `unison_test`

`unison_test` runs the **already-committed** test suite. The first run after
any change may report cached results from the previous version of the
codebase — clear the cache before re-running:

```
unison_ucm: debug.clear-cache
unison_test
```

The cache only becomes stale across commits; a `test>` watch expression in
the scratch file is always fresh, which is another reason to prefer it
during the edit loop.

## Tools

| Tool | Use for |
|------|---------|
| `unison_typecheck` | check source without committing |
| `unison_update` | typecheck + commit in one call (only if the user wants to persist) |
| `unison_view` | read (pretty-printed) source of existing definitions |
| `unison_dump` | read **re-loadable** source of existing definitions (for editing) |
| `unison_find` | search by name, or `: <type>` for type-directed search |
| `unison_test` | run the **committed** test suite (use `test>` watches for the edit loop) |
| `unison_status` | show bound codebase, default project, available projects |
| `unison_ucm` | escape hatch for any other UCM command |

## Targeting a project/branch

The `project` argument to each tool is optional. When omitted, the default
is resolved in this order, on **every call** (so a `switch` issued mid-session
is picked up automatically):

1. `--unison-project` flag / `UNISON_PROJECT` env var (explicit, wins).
2. **UCM's current project context** — read from the codebase's
   `current_project_path` SQLite table. This is the project/branch the user
   most recently navigated to via `switch`, `cd`, or `popd` in their
   interactive UCM session. The UCM MCP server uses the same mechanism.
3. `"scratch/main"` (final fallback).

So in the common case — the user has been working in UCM and now wants help
with whatever branch they were last on — there is no need to pass `project`
at all. For the auto-typecheck on `.u` edits, a leading header line
`-- @unison-project: proj/branch` overrides steps 1 and 2 for that file.

If results are unexpectedly empty, run `unison_status` to confirm which
codebase and project are actually being hit. (`codebase` defaults to
`~/.unison/v2/`; override with `--unison-codebase` / `UNISON_CODEBASE`.)

## Editing existing definitions & ability changes

- To modify an existing definition, fetch it with **`unison_dump`** (not
  `unison_view` — the pretty-printer doesn't always round-trip), edit it, then
  `unison_update`.
- Adding a constructor to an **ability** makes every handler of that ability
  non-exhaustive. `unison_update` will then return **incomplete**, including
  UCM's canonical, re-loadable source for the *entire* affected-definition
  closure (the `⚠ update incomplete` payload). Add the missing cases to that
  source and call `unison_update` again to complete the merge. Include the whole
  closure in one update so no reference to the old ability hash remains.

## Common `unison_ucm` commands

- `lib.install @unison/base` — install a library from Share
- `merge /topic` / `merge.commit` — branch merges
- `docs List.map` — render a definition's docs
- `run myMain` — execute a definition
- `branch /feature`, `switch /main` — branch ops
- `delete.term foo`, `move.term a b` — edits
- `project.create`, `projects`, `branches` — project management (or `unison_status` for orientation)

## Language notes

- Types: `Nat Int Float Text Boolean Bytes Char`, `[a]` lists, `(a, b)` tuples.
- Signatures optional but preferred: `double : Nat -> Nat` / `double x = x + x`.
- **Abilities** (effects) use `{Ability}` in signatures and `handle … with` /
  `Ability.op` to perform/handle. Common: `{IO}`, `{Exception}`, `{Stream a}`.
- Tests: prefer `test> myTest = test.verify do …` watch expressions in the
  scratch file (see [Testing](#testing)). They evaluate without committing.
  Use the inline form `test> mynamedtestterm = …` if you want a named term
  after commit.
- `use` brings names into scope: `use base.List map filter`.
- Everything is immutable; there are no statements, only expressions.

## Reading typecheck errors

UCM error output names the unresolved/mismatched identifier and the line. If a
name won't resolve, it's usually missing a `use` clause or an uninstalled
library — check `unison_find` for the right name, or `lib.install` the library.
