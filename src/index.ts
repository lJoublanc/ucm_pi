// Token-efficient Unison / UCM support for pi — no MCP.
//
// Token strategy baked in from the start:
//   #1 prune stale read-only results from context      -> `context` handler
//   #2 tiny tool catalog                                -> registerTool below
//   #3 filter/summarize UCM output at the source        -> src/ucm.ts
//   #4 fewer round trips (composite tools + auto-check)  -> unison_update + hook
//   #5 knowledge in a skill, not the system prompt       -> skills/unison
//   #6 cache-friendly: stable prompt, no mid-run churn   -> per-turn injection
//
// Every tool accepts an optional `project` (project/branch) so a single session
// can operate across projects; it falls back to the configured default.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import { createUcm, detectCurrentProject, type Ucm } from "./ucm.ts";
import { pruneStaleUnisonResults } from "./prune.ts";

const PROJECT_PARAM = Type.Optional(
  Type.String({
    description:
      "project/branch to target, e.g. `myproject/main`. Defaults to the configured project.",
  }),
);

export default function (pi: ExtensionAPI) {
  pi.registerFlag("unison-codebase", {
    description: "Path to the Unison codebase (defaults to UCM's default codebase)",
    type: "string",
  });
  pi.registerFlag("unison-project", {
    description: "Default project/branch operations run against (deps must resolve here)",
    type: "string",
    default: "",
  });

  // Default-project resolution chain. Each call re-evaluates so a `switch`
  // issued via `unison_ucm` (or by the user in an interactive UCM) is picked
  // up on the next tool call: UCM writes the new project to the codebase's
  // `current_project_path` SQLite table, and we read that table here.
  //
  //   1. `--unison-project` flag (explicit, wins)
  //   2. `UNISON_PROJECT` env var       (explicit, wins)
  //   3. UCM's current project context  (auto-detected from SQLite)
  //   4. `"scratch/main"`               (final fallback)
  const codebasePath = (): string | undefined =>
    (pi.getFlag("unison-codebase") as string) || process.env.UNISON_CODEBASE || undefined;
  const defaultProject = (): string => {
    const explicit =
      (pi.getFlag("unison-project") as string) || process.env.UNISON_PROJECT;
    if (explicit?.trim()) return explicit.trim();
    const detected = detectCurrentProject(codebasePath());
    return detected ?? "scratch/main";
  };

  let ucm: Ucm | undefined;
  const getUcm = (): Ucm => {
    if (!ucm) {
      ucm = createUcm({
        exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
        codebase: codebasePath(),
        // Thunk, so each tool call re-reads the current project from SQLite
        // (and so a `switch` mid-session lands on the right branch next time).
        project: defaultProject,
        timeoutMs: 120_000,
      });
    }
    return ucm;
  };

  const toResult = (r: Awaited<ReturnType<Ucm["typecheck"]>>) => {
    if (r.isError) throw new Error(r.text); // sets isError + reports to LLM
    return { content: [{ type: "text" as const, text: r.text }], details: r.details };
  };
  // Non-throwing variant: delivers content (and isError) rather than throwing,
  // so rich payloads — an update's affected-definition dump, a failed query —
  // reach the model intact. Carries pruneKey into details for #1.
  const toResultKeyed = (r: Awaited<ReturnType<Ucm["typecheck"]>>) => ({
    content: [{ type: "text" as const, text: r.text }],
    details: { ...r.details, pruneKey: r.pruneKey },
    isError: r.isError,
  });

  // ---- #2: minimal, high-signal tool catalog -----------------------------

  pi.registerTool({
    name: "unison_typecheck",
    label: "Unison Typecheck",
    description:
      "Typecheck Unison source WITHOUT committing it. Returns only compiler diagnostics. " +
      "Run this after writing/editing definitions and before claiming code works.",
    promptSnippet: "Typecheck Unison source and get only the compiler diagnostics",
    parameters: Type.Object({
      code: Type.String({ description: "Unison source to typecheck" }),
      scratchPath: Type.Optional(
        Type.String({ description: "Scratch file this code belongs to (for de-duplication)" }),
      ),
      project: PROJECT_PARAM,
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
      const key = `typecheck:${params.scratchPath ? resolve(ctx.cwd, params.scratchPath) : "inline"}`;
      return toResultKeyed(await getUcm().typecheck(params.code, key, signal, params.project));
    },
  });

  pi.registerTool({
    name: "unison_update",
    label: "Unison Update",
    description:
      "Typecheck AND commit Unison source to the codebase in one step. " +
      "Prefer this over separate typecheck+add/update calls. If the change makes " +
      "existing definitions non-exhaustive (e.g. adding an ability constructor), " +
      "the result includes UCM's canonical source for every affected definition — " +
      "fix those and call unison_update again to complete the merge.",
    promptSnippet: "Typecheck and commit Unison definitions to the codebase in one call",
    parameters: Type.Object({
      code: Type.String({ description: "Unison source to add/update in the codebase" }),
      project: PROJECT_PARAM,
    }),
    async execute(_id, params, signal) {
      // Non-throwing: an incomplete update returns the affected-definition dump
      // as content the model must act on, not a bare error string.
      return toResultKeyed(await getUcm().update(params.code, signal, params.project));
    },
  });

  pi.registerTool({
    name: "unison_view",
    label: "Unison View",
    description:
      "Show the source of definitions from the codebase (definitions do NOT live in files — " +
      "never use grep/read for codebase contents). Accepts names, e.g. `List.map base.Nat.gt`.",
    promptSnippet: "View the source of Unison definitions stored in the codebase",
    parameters: Type.Object({
      names: Type.String({ description: "Space-separated definition names to view" }),
      project: PROJECT_PARAM,
    }),
    async execute(_id, params, signal) {
      return toResultKeyed(
        await getUcm().query(
          `view ${params.names}`,
          `view:${params.project ?? ""}:${params.names.trim()}`,
          signal,
          params.project,
        ),
      );
    },
  });

  pi.registerTool({
    name: "unison_dump",
    label: "Unison Dump",
    description:
      "Dump canonical, RE-LOADABLE source of existing definitions (via `edit.new`). " +
      "Unlike unison_view's pretty-printer, this output round-trips cleanly through " +
      "unison_update — use it when you need to edit an existing definition and commit " +
      "it back. Accepts space-separated names.",
    promptSnippet: "Dump re-loadable source of existing definitions for editing",
    parameters: Type.Object({
      names: Type.String({ description: "Space-separated definition names to dump" }),
      project: PROJECT_PARAM,
    }),
    async execute(_id, params, signal) {
      return toResultKeyed(
        await getUcm().dump(
          params.names,
          `dump:${params.project ?? ""}:${params.names.trim()}`,
          signal,
          params.project,
        ),
      );
    },
  });

  pi.registerTool({
    name: "unison_find",
    label: "Unison Find",
    description:
      "Search the codebase for definitions by name fragment or by type signature " +
      "(use `find` for names, `find : <type>` for type-directed search).",
    promptSnippet: "Search the Unison codebase for definitions by name or type",
    parameters: Type.Object({
      query: Type.String({ description: "Name fragment, or `: Nat -> Nat` for type search" }),
      project: PROJECT_PARAM,
    }),
    async execute(_id, params, signal) {
      const q = params.query.trim();
      return toResultKeyed(
        await getUcm().query(`find ${q}`, `find:${params.project ?? ""}:${q}`, signal, params.project),
      );
    },
  });

  pi.registerTool({
    name: "unison_test",
    label: "Unison Test",
    description: "Run the project's test suite and return the results.",
    promptSnippet: "Run the Unison project's tests",
    parameters: Type.Object({ project: PROJECT_PARAM }),
    async execute(_id, params, signal) {
      return toResult(await getUcm().test(signal, params.project));
    },
  });

  pi.registerTool({
    name: "unison_status",
    label: "Unison Status",
    description:
      "Show which codebase and default project/branch the Unison tools are bound to, " +
      "plus the list of projects in the codebase. Use this to orient before other tools " +
      "if targeting seems wrong (e.g. results are unexpectedly empty).",
    promptSnippet: "Show the bound codebase, default project, and available projects",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return toResult(await getUcm().status(signal));
    },
  });

  pi.registerTool({
    name: "unison_ucm",
    label: "UCM Command",
    description:
      "Escape hatch: run raw UCM command(s) (e.g. `lib.install @unison/base`, `merge /topic`, " +
      "`branches`, `docs List.map`, `run myMain`, `delete.term foo`). One command per array entry.",
    promptSnippet: "Run raw UCM commands for operations the dedicated tools do not cover",
    parameters: Type.Object({
      commands: Type.Array(Type.String(), {
        description: "UCM commands to run in sequence, without the project/branch prompt prefix",
      }),
      project: PROJECT_PARAM,
    }),
    async execute(_id, params, signal) {
      return toResult(await getUcm().raw(params.commands, signal, params.project));
    },
  });

  // ---- #1: prune stale read-only results before every LLM call -----------
  pi.on("context", (event) => ({ messages: pruneStaleUnisonResults(event.messages) }));

  // ---- #4: auto-typecheck on .u edits (saves a whole round trip) ----------
  // When the model writes/edits a scratch file, append fresh diagnostics to the
  // edit result so it never needs a separate turn (and context re-send) to check.
  // A leading `-- @unison-project: proj/branch` line in the file targets that
  // branch (so the file resolves against the right dependencies).
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const path = (event.input as { path?: string })?.path;
    if (!path || !path.endsWith(".u")) return;
    try {
      const abs = resolve(ctx.cwd, path);
      const { readFile } = await import("node:fs/promises");
      const code = await readFile(abs, "utf8");
      const header = code.match(/^\s*--\s*@unison-project:\s*(\S+)/m);
      const diag = await getUcm().typecheck(
        code,
        `typecheck:${abs}`,
        ctx.signal,
        header?.[1],
      );
      const proj = header?.[1] ?? defaultProject();
      return {
        content: [
          ...event.content,
          { type: "text", text: `\n── unison typecheck (${path} @ ${proj}) ──\n${diag.text}` },
        ],
      };
    } catch {
      return; // never break the underlying edit on typecheck failure
    }
  });

  // ---- #6: per-turn branch status via footer, not the system prompt ------
  pi.on("session_start", (_event, ctx) => {
    const d = getUcm().describe();
    ctx.ui.setStatus("unison", `⬡ ${d.project}`);
  });

  // ---- manual entry point for the human ----------------------------------
  pi.registerCommand("ucm", {
    description: "Run a raw UCM command (optionally `@project/branch <command>`)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) return void ctx.ui.notify("usage: /ucm [@project/branch] <command>", "warning");
      const m = trimmed.match(/^@(\S+)\s+(.*)$/);
      const project = m?.[1];
      const command = m?.[2] ?? trimmed;
      const r = await getUcm().raw([command], ctx.signal, project);
      ctx.ui.notify(r.text.slice(0, 2000), r.isError ? "error" : "info");
    },
  });
}
