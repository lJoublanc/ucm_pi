// Token-efficient Unison / UCM support for pi — no MCP.
//
// Token strategy baked in from the start:
//   #1 prune stale read-only results from context      -> `context` handler
//   #2 tiny tool catalog (6 tools, not UCM-MCP's 29)    -> registerTool below
//   #3 filter/summarize UCM output at the source        -> src/ucm.ts
//   #4 fewer round trips (composite tools + auto-check)  -> unison_update + hook
//   #5 knowledge in a skill, not the system prompt       -> skills/unison
//   #6 cache-friendly: stable prompt, no mid-run churn   -> per-turn injection

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolve } from "node:path";
import { createUcm, type Ucm } from "./ucm.ts";
import { pruneStaleUnisonResults } from "./prune.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("unison-codebase", {
    description: "Path to the Unison codebase (defaults to UCM's default codebase)",
    type: "string",
  });
  pi.registerFlag("unison-project", {
    description: "project/branch transcripts run against (deps must resolve here)",
    type: "string",
    default: "",
  });

  let ucm: Ucm | undefined;
  const getUcm = (): Ucm => {
    if (!ucm) {
      ucm = createUcm({
        exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
        codebase:
          (pi.getFlag("unison-codebase") as string) || process.env.UNISON_CODEBASE || undefined,
        project:
          (pi.getFlag("unison-project") as string) ||
          process.env.UNISON_PROJECT ||
          "scratch/main",
        timeoutMs: 120_000,
      });
    }
    return ucm;
  };

  const toResult = (r: Awaited<ReturnType<Ucm["typecheck"]>>) => {
    if (r.isError) throw new Error(r.text); // sets isError + reports to LLM
    return { content: [{ type: "text" as const, text: r.text }], details: r.details };
  };
  // Non-throwing variant that still carries pruneKey into details for #1.
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
      const key = `typecheck:${params.scratchPath ? resolve(ctx.cwd, params.scratchPath) : "inline"}`;
      return toResultKeyed(await getUcm().typecheck(params.code, key, signal));
    },
  });

  pi.registerTool({
    name: "unison_update",
    label: "Unison Update",
    description:
      "Typecheck AND commit Unison source to the codebase in one step. " +
      "Prefer this over separate typecheck+add/update calls.",
    promptSnippet: "Typecheck and commit Unison definitions to the codebase in one call",
    parameters: Type.Object({
      code: Type.String({ description: "Unison source to add/update in the codebase" }),
    }),
    async execute(_id, params, signal) {
      return toResult(await getUcm().update(params.code, signal));
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
    }),
    async execute(_id, params, signal) {
      return toResultKeyed(
        await getUcm().query(`view ${params.names}`, `view:${params.names.trim()}`, signal),
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
    }),
    async execute(_id, params, signal) {
      const q = params.query.trim();
      return toResultKeyed(await getUcm().query(`find ${q}`, `find:${q}`, signal));
    },
  });

  pi.registerTool({
    name: "unison_test",
    label: "Unison Test",
    description: "Run the project's test suite and return the results.",
    promptSnippet: "Run the Unison project's tests",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return toResult(await getUcm().test(signal));
    },
  });

  pi.registerTool({
    name: "unison_ucm",
    label: "UCM Command",
    description:
      "Escape hatch: run raw UCM command(s) (e.g. `lib.install @unison/base`, `merge /topic`, " +
      "`docs List.map`, `run myMain`, `delete.term foo`). One command per array entry.",
    promptSnippet: "Run raw UCM commands for operations the dedicated tools do not cover",
    parameters: Type.Object({
      commands: Type.Array(Type.String(), {
        description: "UCM commands to run in sequence, without the project/branch prompt prefix",
      }),
    }),
    async execute(_id, params, signal) {
      return toResult(await getUcm().raw(params.commands, signal));
    },
  });

  // ---- #1: prune stale read-only results before every LLM call -----------
  pi.on("context", (event) => ({ messages: pruneStaleUnisonResults(event.messages) }));

  // ---- #4: auto-typecheck on .u edits (saves a whole round trip) ----------
  // When the model writes/edits a scratch file, append fresh diagnostics to the
  // edit result so it never needs a separate turn (and context re-send) to check.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const path = (event.input as { path?: string })?.path;
    if (!path || !path.endsWith(".u")) return;
    try {
      const abs = resolve(ctx.cwd, path);
      const { readFile } = await import("node:fs/promises");
      const code = await readFile(abs, "utf8");
      const diag = await getUcm().typecheck(code, `typecheck:${abs}`, ctx.signal);
      return {
        content: [
          ...event.content,
          { type: "text", text: `\n── unison typecheck (${path}) ──\n${diag.text}` },
        ],
      };
    } catch {
      return; // never break the underlying edit on typecheck failure
    }
  });

  // ---- #6: per-turn branch status via footer, not the system prompt ------
  pi.on("session_start", (_event, ctx) => {
    const project =
      (pi.getFlag("unison-project") as string) || process.env.UNISON_PROJECT || "scratch/main";
    ctx.ui.setStatus("unison", `⬡ ${project}`);
  });

  // ---- manual entry point for the human ----------------------------------
  pi.registerCommand("ucm", {
    description: "Run a raw UCM command",
    handler: async (args, ctx) => {
      if (!args.trim()) return void ctx.ui.notify("usage: /ucm <command>", "warning");
      const r = await getUcm().raw([args.trim()], ctx.signal);
      ctx.ui.notify(r.text.slice(0, 2000), r.isError ? "error" : "info");
    },
  });
}
