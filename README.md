# unison-pi-tool

Token-efficient Unison / UCM support for the [pi](https://github.com/earendil-works/pi-mono)
coding agent — **without MCP**.

UCM ships an MCP server, but its tool catalog injects ~6,800 tokens of schemas
into *every* request (29 tools), and every tool result accumulates in context
and is re-sent on every turn. This extension implements the same capability as a
pi extension + skill and is built around six token-reduction strategies.

## What's inside

| File | Role |
|------|------|
| `src/index.ts` | Registers the tools, `/ucm` command, flags, and the token-saving event hooks |
| `src/ucm.ts` | Transcript-backed UCM driver: runs `ucm transcript.in-place`, parses the clean `*.output.md`, filters/summarizes/truncates output |
| `src/prune.ts` | `context` handler that stubs out superseded read-only results |
| `skills/unison/SKILL.md` | The Unison/UCM workflow knowledge (loaded on demand) |

## Token strategy

1. **Prune stale results** (`src/prune.ts`). The `context` event fires before
   each LLM call; we walk messages newest-first and stub out any read-only
   Unison result (`view`/`find`/`typecheck`) superseded by a newer one with the
   same `pruneKey`. This is the biggest win — MCP re-sends all of them forever.
2. **Tiny catalog** — a handful of high-signal tools instead of 29. Rare ops go
   through the one `unison_ucm` escape hatch.
3. **Filter at the source** (`src/ucm.ts`). We parse UCM's `*.output.md`, return
   only diagnostics / summaries, strip echoed prompt lines, and truncate with the
   full output spilled to a temp file.
4. **Fewer round trips.** `unison_update` typechecks *and* commits in one
   transcript; editing a `.u` file auto-appends fresh diagnostics to the edit
   result, so no separate typecheck turn (and no extra context re-send).
5. **Knowledge in a skill,** not the system prompt — only the one-line
   description is always in context.
6. **Cache-friendly** — stable prompt and tool set; branch status goes in the
   footer, not the system prompt.

## Install

```bash
pi install git:github.com/you/unison-pi-tool
# or point settings.json at a local checkout:
#   { "extensions": ["/path/to/unison-pi-tool/src/index.ts"],
#     "skills":     ["/path/to/unison-pi-tool/skills"] }
```

Requires the `ucm` binary (Unison 1.3+) on `PATH`.

## Configure

The transcript stanzas run against a project/branch where your dependencies
resolve (a fresh codebase has no builtins/base). Point the tools at your real
project:

```bash
pi --unison-project myproject/main --unison-codebase /path/to/codebase
# or via env:
export UNISON_PROJECT=myproject/main
export UNISON_CODEBASE=/path/to/codebase
```

This is only the **default**. Every tool also takes an optional `project`
argument, so one session can operate across projects/branches. If unset, the
defaults are `scratch/main` and UCM's default codebase. Run `unison_status` to
see what's actually bound.

## Tools

- `unison_typecheck` — check source without committing (diagnostics only)
- `unison_update` — typecheck + commit in one call (preferred). On a partial
  failure (e.g. adding an ability constructor makes handlers non-exhaustive) it
  returns UCM's canonical, re-loadable source for the whole affected-definition
  closure — fix it and call `unison_update` again to finish the merge.
- `unison_view` — read pretty-printed source of existing definitions
- `unison_dump` — read **re-loadable** source (via `edit.new`) for editing +
  committing back; use this instead of `unison_view` when you'll modify a def
- `unison_find` — search by name or `: <type>`
- `unison_test` — run the test suite
- `unison_status` — show the bound codebase, default project, and projects list
- `unison_ucm` — escape hatch for any other UCM command

Every tool takes an optional `project` (e.g. `blas/asum`). The auto-typecheck on
`.u` edits honours a leading `-- @unison-project: proj/branch` header. Plus
`/ucm [@project/branch] <command>` for manual use.

## Development

Loaded via jiti — no build step. Local imports use `.ts` extensions per pi
convention. `src/ucm.ts` parses `*.output.md` (clean markdown), never stdout
(which is full of ANSI/banners).
