---
name: unison
description: Write Unison code and interact with a UCM (Unison Codebase Manager) codebase. Use whenever editing .u scratch files, adding/updating definitions, installing libraries, running tests, or querying definitions. Covers the scratch-file workflow and the fact that definitions live in the codebase, not in files.
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
3. Commit with `unison_update` (typechecks **and** adds/updates in one step).
4. Run `unison_test` to verify.

Do not call `unison_typecheck` and then `unison_update` separately for the same
code — `unison_update` already typechecks. Fewer calls = fewer tokens.

## Tools

| Tool | Use for |
|------|---------|
| `unison_typecheck` | check source without committing |
| `unison_update` | typecheck + commit in one call (preferred) |
| `unison_view` | read source of existing definitions |
| `unison_find` | search by name, or `: <type>` for type-directed search |
| `unison_test` | run the test suite |
| `unison_ucm` | escape hatch for any other UCM command |

## Common `unison_ucm` commands

- `lib.install @unison/base` — install a library from Share
- `merge /topic` / `merge.commit` — branch merges
- `docs List.map` — render a definition's docs
- `run myMain` — execute a definition
- `branch /feature`, `switch /main` — branch ops
- `delete.term foo`, `move.term a b` — edits
- `project.create`, `projects`, `branches` — project management

## Language notes

- Types: `Nat Int Float Text Boolean Bytes Char`, `[a]` lists, `(a, b)` tuples.
- Signatures optional but preferred: `double : Nat -> Nat` / `double x = x + x`.
- **Abilities** (effects) use `{Ability}` in signatures and `handle … with` /
  `Ability.op` to perform/handle. Common: `{IO}`, `{Exception}`, `{Stream a}`.
- Tests: `test> myTest = check (1 + 1 == 2)` — watch expressions with `test>`.
- `use` brings names into scope: `use base.List map filter`.
- Everything is immutable; there are no statements, only expressions.

## Reading typecheck errors

UCM error output names the unresolved/mismatched identifier and the line. If a
name won't resolve, it's usually missing a `use` clause or an uninstalled
library — check `unison_find` for the right name, or `lib.install` the library.
