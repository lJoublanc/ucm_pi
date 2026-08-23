// Transcript-backed UCM driver.
//
// Everything routes through `ucm transcript.in-place`, which runs a markdown
// transcript against the real codebase and writes a clean, ANSI-free
// `<file>.output.md`. We parse THAT (not stdout) and return only the parts the
// model needs — the whole point of the token-reduction strategy (#3, "filter at
// the source"). Mutating runs are serialized through a promise queue because
// transcripts and any headless server share one SQLite codebase.
//
// Every operation is anchored to an explicit `project/branch` (per call, with a
// configured default): the source is written to a temp `.u` file and brought in
// with `<project>> load <file>` so it elaborates against the intended branch's
// dependencies. A bare ```unison``` block would instead elaborate against the
// codebase's *current* branch, which is why targeting used to silently land on
// the wrong project.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

// `node:sqlite` is experimental in Node 22, stable in 23. Loaded lazily so
// a missing module just degrades to "no auto-detection" instead of crashing
// at import time.
const localRequire = createRequire(import.meta.url);

export interface ExecFn {
  (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }>;
}

export interface UcmConfig {
  exec: ExecFn;
  /** Absolute path to a codebase, or undefined to use UCM's default codebase. */
  codebase?: string;
  /**
   * Default project/branch operations run against when a call omits one.
   * May be a string (captured once) or a thunk (re-evaluated each call —
   * useful when the source can change, e.g. UCM's `current_project_path`
   * table after a `switch`). An empty / nullish return from the thunk
   * falls back to `"scratch/main"`.
   */
  project: string | (() => string | null | undefined);
  timeoutMs: number;
}

export interface UcmResult {
  /** Text sent to the LLM (already filtered + truncated). */
  text: string;
  isError: boolean;
  /** Full, untruncated output on disk, if truncation happened. */
  fullOutputPath?: string;
  /** Stable key for context de-duplication (see prune.ts). Read-only tools only. */
  pruneKey?: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Current-project detection from the UCM codebase
// ---------------------------------------------------------------------------
//
// UCM stores the user's "current project context" (the project/branch they most
// recently navigated to via `switch`, `cd`, or `popd`) in a single-row SQLite
// table at <codebase>/.unison/v2/unison.sqlite3. This is exactly what the UCM
// MCP server's `currentProjectContext` helper reads.
//
// Reading it directly lets us avoid the `--unison-project` flag in the common
// case where the user has already been working in UCM. Always best-effort: any
// failure (no file, no row, locked DB, no `node:sqlite`) returns null so the
// caller can fall back to its other strategies.

/** Path to the SQLite database for the given codebase root, or null if not
 *  derivable. Matches UCM's `makeCodebasePath` (parser-typechecker/.../Paths.hs):
 *  `<root>/.unison/v2/unison.sqlite3`. An explicit `.sqlite3` path is used as-is. */
function resolveCodebaseSqlitePath(codebasePath?: string): string | null {
  if (!codebasePath) return join(homedir(), ".unison", "v2", "unison.sqlite3");
  if (codebasePath.endsWith(".sqlite3")) return codebasePath;
  if (codebasePath.endsWith(".unison") || codebasePath.endsWith(".unison/v2"))
    return join(codebasePath, "unison.sqlite3");
  return join(codebasePath, ".unison", "v2", "unison.sqlite3");
}

/**
 * Read the UCM codebase's `current_project_path` table and return the
 * current project/branch in `proj/branch` form, or null if it can't be
 * determined. Safe to call repeatedly: the whole thing is wrapped in
 * try/catch and the SQLite handle is closed in `finally`.
 */
export function detectCurrentProject(codebasePath?: string): string | null {
  const dbPath = resolveCodebaseSqlitePath(codebasePath);
  if (!dbPath || !existsSync(dbPath)) return null;
  let db: { close: () => void; prepare: (sql: string) => { get: () => unknown } } | null = null;
  try {
    const sqlite = localRequire("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean },
      ) => { close: () => void; prepare: (sql: string) => { get: () => unknown } };
    };
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT p.name || '/' || pb.name AS pp
         FROM current_project_path cpp
         JOIN project p       ON cpp.project_id = p.id
         JOIN project_branch pb ON cpp.project_id = pb.project_id
                              AND cpp.branch_id = pb.branch_id
         LIMIT 1`,
      )
      .get() as { pp?: string } | undefined;
    return row?.pp ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization: one codebase, so mutations must not overlap.
// ---------------------------------------------------------------------------
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// output.md parsing
// ---------------------------------------------------------------------------
interface Block {
  info: string; // e.g. "unison", "ucm", "unison :added-by-ucm", "" (plain)
  body: string;
}

// Fences may be 3+ backticks; UCM uses 4 (````) around the `:added-by-ucm`
// dump, so match a run of >=3 and require the closing run to be >= the opener.
function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^(`{3,})(.*)$/);
    if (!open) {
      i++;
      continue;
    }
    const fence = open[1];
    const info = open[2].trim();
    const body: string[] = [];
    i++;
    const close = new RegExp("^`{" + fence.length + ",}\\s*$");
    while (i < lines.length && !close.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    i++; // consume closing fence
    blocks.push({ info, body: body.join("\n").replace(/\s+$/, "") });
  }
  return blocks;
}

const FAILED = "The transcript failed due to an error";
const NO_LOCK = "Failed to obtain a file lock";
const NO_CODEBASE = "No codebase exists";

/** Concatenated bodies of plain ``` blocks — where UCM puts compiler errors. */
function errorText(md: string): string {
  const plain = parseBlocks(md)
    .filter((b) => b.info === "")
    .map((b) => b.body.trim())
    .filter(Boolean);
  const text = (plain.join("\n\n") || md).trim();
  // Surface environment-level failures plainly instead of burying them.
  if (md.includes(NO_LOCK)) {
    return (
      "UCM could not obtain the codebase file lock — another UCM process " +
      "(e.g. an interactive `ucm`, or a headless server) is holding it. Close " +
      "it and retry.\n\n" +
      text
    );
  }
  if (md.includes(NO_CODEBASE)) {
    return (
      "No Unison codebase was found at the configured location. Check the " +
      "`--unison-codebase` flag / UNISON_CODEBASE env var.\n\n" +
      text
    );
  }
  return text;
}

/** Bodies of the `ucm` result blocks, with echoed `project/branch> cmd` prompt
 * lines stripped (the model already knows what it ran). Falls back to the raw
 * block bodies if stripping would leave nothing, so real output is never lost. */
function ucmOutput(md: string): string {
  const blocks = parseBlocks(md).filter((b) => b.info.startsWith("ucm"));
  if (blocks.length === 0) return "";
  const stripped = blocks
    .map((b) =>
      b.body
        .split("\n")
        .filter((l) => !/^\s*\S+\/\S+>\s/.test(l))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (stripped) return stripped;
  // Everything was prompt lines (e.g. a command with no result) — return the
  // raw bodies rather than an empty string so the caller can tell it apart from
  // "no blocks at all".
  return blocks
    .map((b) => b.body.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** The canonical, re-loadable source UCM writes when an `update` leaves
 * existing definitions to be fixed by hand (the `:added-by-ucm` block). */
function addedByUcm(md: string): string {
  const b = parseBlocks(md).find((x) => x.info.includes("added-by-ucm"));
  return b ? b.body.trim() : "";
}

/** Names from numbered listings like `branches` / `diff.namespace` output —
 *  one `N. name` per line; type signatures wrap onto continuation lines that
 *  never match the `N.` prefix, so this is names-only by construction. */
export function parseNumberedNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+\.\s+(?:(?:ability|type)\s+)?(\S+)/);
    if (m) names.push(m[1]);
  }
  return names;
}

// Phrases UCM prints when `update` can't finish automatically because existing
// dependents would no longer typecheck. In that case UCM stages the change on a
// temporary `update-<branch>` branch, leaves the working branch mid-merge, and
// rewrites the loaded scratch file with the full affected-definition closure.
// This happens for BOTH a narrowed term signature (breaks callers) and an
// ability gaining a constructor (makes handlers non-exhaustive).
const INCOMPLETE_UPDATE_MARKERS = [
  "I couldn't complete the update",
  "added the affected definitions",
  "created a temporary branch",
];
function isIncompleteUpdate(md: string): boolean {
  return INCOMPLETE_UPDATE_MARKERS.some((m) => md.includes(m));
}

// UCM's `load` summary lists one definition per line, marked `+` (added) or
// `~` (modified), with a trailing legend line "+ (added), ~ (modified)".
// Signatures wrap across continuation lines. We keep NAMES ONLY, by design:
// echoing full signatures back is pure token overhead (the model just
// submitted that exact source), and the previous `name : type` regex silently
// truncated wrapped types to their first line and missed `~` and `type` lines
// entirely — which made committed updates look absent from the summary.
function defSummary(md: string): { added: string[]; modified: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*([+~])\s+(\S.*)$/);
    if (!m) continue;
    let name = m[2].trim();
    const colon = name.indexOf(" : ");
    if (colon !== -1) name = name.slice(0, colon).trimEnd();
    if (!name || name.startsWith("(")) continue; // legend: "+ (added), ~ (modified)"
    (m[1] === "~" ? modified : added).push(name);
  }
  return { added, modified };
}

/** Render a defSummary as indented `+`/`~` lines (types are kept as `type Foo`). */
function formatDefs(s: { added: string[]; modified: string[] }): string {
  return [...s.added.map((n) => `  + ${n}`), ...s.modified.map((n) => `  ~ ${n}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Transcript runner
// ---------------------------------------------------------------------------
export function createUcm(config: UcmConfig) {
  const { exec, codebase, project: defaultProject, timeoutMs } = config;

  interface RunOpts {
    project: string;
    /** Source written to a temp `.u` and brought in with `load` before commands. */
    code?: string;
    /** UCM commands (prompt prefix added automatically), run after any `load`. */
    commands?: string[];
    /** Read the loaded `.u` file back after the run. UCM rewrites it in place
     *  when `update` can't finish (staging the affected-definition closure);
     *  we must recover that content BEFORE the temp dir is deleted. */
    captureRewrite?: boolean;
    signal?: AbortSignal;
  }

  async function runTranscript(
    opts: RunOpts,
  ): Promise<{ ok: boolean; md: string; rewrittenCode?: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-ucm-"));
    const src = join(dir, "t.md");
    const out = join(dir, "t.output.md");
    const codePath = join(dir, "code.u");
    try {
      const prompts: string[] = [];
      if (opts.code !== undefined) {
        await writeFile(codePath, opts.code.replace(/\s+$/, "") + "\n", "utf8");
        prompts.push(`${opts.project}> load ${codePath}`);
      }
      for (const c of opts.commands ?? []) prompts.push(`${opts.project}> ${c}`);
      const transcript = prompts.map((p) => "```ucm\n" + p + "\n```").join("\n\n") + "\n";
      await writeFile(src, transcript, "utf8");
      const args = [...(codebase ? ["-c", codebase] : []), "transcript.in-place", src];
      await exec("ucm", args, { signal: opts.signal, timeout: timeoutMs });
      const md = await readFile(out, "utf8").catch(() => "");
      // Recover the (possibly UCM-rewritten) scratch file while it still exists.
      // If `update` couldn't complete, UCM writes the affected-definition closure
      // back into this file — the single `readFile` that used to be missing, so
      // the closure was `rm -rf`'d in `finally` before the agent could see it.
      let rewrittenCode: string | undefined;
      if (opts.code !== undefined && opts.captureRewrite) {
        const after = (await readFile(codePath, "utf8").catch(() => "")).replace(/\s+$/, "");
        if (after && after !== opts.code.replace(/\s+$/, "")) rewrittenCode = after;
      }
      return { ok: md !== "" && !md.includes(FAILED), md, rewrittenCode };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Branch names of any `update-<branch>` staging branches on `proj`. */
  async function pendingUpdateBranches(proj: string, signal?: AbortSignal): Promise<string[]> {
    const branch = proj.includes("/") ? proj.slice(proj.indexOf("/") + 1) : proj;
    const listed = await runTranscript({ project: proj, commands: ["branches"], signal }).catch(
      () => ({ ok: false, md: "" }) as { ok: boolean; md: string },
    );
    if (!listed.ok) return [];
    const prefix = `update-${branch}`;
    const names = new Set<string>();
    for (const name of parseNumberedNames(ucmOutput(listed.md))) {
      if (name === prefix || name.startsWith(prefix + "-")) names.add(name);
    }
    return [...names];
  }

  /** The set of definitions an incomplete `update` excised onto its staging
   *  branch — the authoritative resubmission set. UCM excises the WHOLE
   *  dependent closure on any propagation failure (not just the definitions
   *  whose source must change), so `diff.namespace /update-<branch>: /<branch>:`
   *  lists exactly what must be resubmitted together. We harvest this BEFORE
   *  cleanupPendingUpdate deletes the staging branch — in transcript mode UCM
   *  often does not write the fix-up file at all, making this the only way to
   *  recover the list. */
  async function affectedUpdateNames(proj: string, signal?: AbortSignal): Promise<string[]> {
    const branch = proj.includes("/") ? proj.slice(proj.indexOf("/") + 1) : proj;
    const staging = await pendingUpdateBranches(proj, signal);
    const names = new Set<string>();
    for (const b of staging) {
      const diff = await runTranscript({
        project: proj,
        commands: [`diff.namespace /${b}: /${branch}:`],
        signal,
      }).catch(() => ({ ok: false, md: "" }) as { ok: boolean; md: string });
      if (!diff.ok) continue;
      for (const name of parseNumberedNames(ucmOutput(diff.md))) names.add(name);
    }
    return [...names].sort();
  }

  /** Best-effort rollback of a failed `update`: abort the pending merge on the
   *  working branch and delete the temporary `update-<branch>` branch(es) UCM
   *  created, so the codebase is left clean and repeated attempts don't stack up
   *  orphaned branches. Each step is its own transcript so one failing (e.g. a
   *  branch that isn't there) never aborts the rest. */
  async function cleanupPendingUpdate(proj: string, signal?: AbortSignal): Promise<void> {
    await runTranscript({ project: proj, commands: ["cancel"], signal }).catch(() => {});
    for (const name of await pendingUpdateBranches(proj, signal)) {
      await runTranscript({ project: proj, commands: [`delete.branch /${name}`], signal }).catch(
        () => {},
      );
    }
  }

  /** Apply the shared truncation policy and stash the overflow on disk. */
  async function finalize(
    text: string,
    isError: boolean,
    extra: Partial<UcmResult> = {},
  ): Promise<UcmResult> {
    const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    let content = t.content;
    let fullOutputPath: string | undefined;
    if (t.truncated) {
      const dir = await mkdtemp(join(tmpdir(), "pi-ucm-full-"));
      fullOutputPath = join(dir, "output.txt");
      await writeFile(fullOutputPath, text, "utf8");
      content +=
        `\n\n[Output truncated: ${t.outputLines}/${t.totalLines} lines, ` +
        `${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}. ` +
        `Full output: ${fullOutputPath} — read it only if you need more.]`;
    }
    return { text: content || "(no output)", isError, fullOutputPath, details: {}, ...extra };
  }

  /** Resolve the project for a call: explicit arg → defaultProject thunk → "scratch/main". */
  const target = (project?: string): string => {
    const explicit = project?.trim();
    if (explicit) return explicit;
    const def = typeof defaultProject === "function" ? defaultProject() : defaultProject;
    return (def ?? "").trim() || "scratch/main";
  };

  return {
    /** The resolved codebase + default project, for status/introspection. */
    describe() {
      const def = typeof defaultProject === "function" ? defaultProject() : defaultProject;
      return {
        codebase: codebase ?? "(UCM default)",
        project: (def ?? "").trim() || "scratch/main",
      };
    },

    /** Typecheck source without committing, against `project` (or the default). */
    async typecheck(
      code: string,
      pruneKey: string,
      signal?: AbortSignal,
      project?: string,
    ): Promise<UcmResult> {
      return serialize(async () => {
        const proj = target(project);
        const { ok, md } = await runTranscript({ project: proj, code, signal });
        if (!ok) return finalize(errorText(md), true, { pruneKey });
        const s = defSummary(md);
        const total = s.added.length + s.modified.length;
        const summary = total
          ? `✓ Typechecks against ${proj}: ${s.added.length} to add, ${s.modified.length} to modify ` +
            `(names only — nothing committed):\n${formatDefs(s)}`
          : `✓ Typechecks against ${proj} (no new/changed definitions).`;
        return finalize(summary, false, { pruneKey });
      });
    },

    /** Typecheck + commit in ONE transcript (one round trip, strategy #4).
     * When `update` can't finish because dependents would break, UCM stages the
     * change on a temporary branch, rewrites the loaded scratch file with the
     * affected-definition closure, and leaves the working branch mid-merge. We
     * recover that closure (before the temp dir is deleted), ROLL BACK the
     * working branch to a clean state, and hand the caller re-loadable source
     * plus the likely cause — rather than a success-looking message that points
     * at an already-deleted file. */
    async update(code: string, signal?: AbortSignal, project?: string): Promise<UcmResult> {
      return serialize(async () => {
        const proj = target(project);
        const { ok, md, rewrittenCode } = await runTranscript({
          project: proj,
          code,
          commands: ["update"],
          captureRewrite: true,
          signal,
        });

        // Incomplete update (checked FIRST, regardless of `ok`): UCM couldn't
        // apply the change automatically. Recover the closure AND the affected-
        // name list (harvested from the staging branch BEFORE rollback — in
        // transcript mode UCM usually does not write the fix-up file, making the
        // staging-branch diff the only recovery path), then undo the
        // half-finished merge so retries start from a clean branch.
        const dump = addedByUcm(md);
        if (isIncompleteUpdate(md) || dump) {
          const closure = rewrittenCode || dump;
          const affected = await affectedUpdateNames(proj, signal);
          await cleanupPendingUpdate(proj, signal);
          const guidance =
            `Fix and resubmit EVERY affected definition together in one ` +
            `unison_update call. Do not filter the list by heuristics (e.g. ` +
            `assuming record accessors are auto-generated — they may be ` +
            `hand-written terms); anything on it with broken source must be ` +
            `included in the resubmission, and everything else on it rides ` +
            `along because UCM excises the whole closure.`;
          const parts = [
            `⚠ update incomplete on ${proj}: some existing definitions would no ` +
              `longer typecheck after this change, so NOTHING was committed. The ` +
              `working branch has been rolled back to a clean state (pending merge ` +
              `cancelled, temporary \`update-*\` branch removed).`,
            `Two common causes:\n` +
              `  • The edited definition's TYPE SIGNATURE changed — often narrowed by ` +
              `inference (a dropped ability or parameter) — which breaks its callers. ` +
              `Retrieve the ORIGINAL signature with unison_dump and pin it explicitly.\n` +
              `  • You added a constructor to an ability, making its handlers ` +
              `non-exhaustive (add the missing cases).`,
          ];
          if (affected.length > 0) {
            parts.push(
              `Affected definitions (${affected.length}) — the authoritative set, ` +
                `harvested from the staging branch before rollback:\n` +
                affected.map((n) => `  ${n}`).join("\n"),
            );
            parts.push(guidance);
          }
          if (closure) {
            parts.push("```unison\n" + closure + "\n```");
          } else if (affected.length === 0) {
            parts.push(
              `(UCM emitted neither the affected-definition source nor a staging ` +
                `branch to harvest names from; run unison_dump on the broken ` +
                `dependents to retrieve re-loadable versions.)`,
            );
            parts.push(guidance);
          }
          return finalize(parts.join("\n\n"), true, {
            details: { affectedDefinitions: affected },
          });
        }

        if (ok) {
          const s = defSummary(md);
          const total = s.added.length + s.modified.length;
          const summary = total
            ? `✓ Committed to ${proj}: ${s.added.length} added, ${s.modified.length} modified ` +
              `(names only):\n${formatDefs(s)}`
            : ucmOutput(md) || `✓ update applied to ${proj}.`;
          return finalize(summary, false);
        }
        return finalize(errorText(md), true);
      });
    },

    /** Dump canonical, re-loadable source of existing definitions via `edit.new`.
     * Unlike `view`'s pretty-printer, this round-trips through `load`/`update`. */
    async dump(names: string, pruneKey: string, signal?: AbortSignal, project?: string) {
      return serialize(async () => {
        const proj = target(project);
        const { ok, md } = await runTranscript({
          project: proj,
          commands: [`edit.new ${names}`],
          signal,
        });
        if (!ok) return finalize(errorText(md), true, { pruneKey });
        const dump = addedByUcm(md);
        return finalize(
          dump ? "```unison\n" + dump + "\n```" : ucmOutput(md) || "(nothing to dump)",
          false,
          { pruneKey },
        );
      });
    },

    /** Structured AST search (sfind / rewrite.find) or search-and-replace across the codebase using a @rewrite rule. */
    async sfind(
      code: string,
      ruleName: string,
      pruneKey: string,
      rewrite?: boolean,
      signal?: AbortSignal,
      project?: string,
    ): Promise<UcmResult> {
      return serialize(async () => {
        const proj = target(project);
        const { ok, md } = await runTranscript({
          project: proj,
          code,
          commands: [`sfind ${ruleName}`],
          signal,
        });
        if (!ok) {
          const err = errorText(md);
          if (err.includes("I couldn't find any matches")) {
            return finalize(err, false, { pruneKey });
          }
          return finalize(err, true, { pruneKey });
        }
        if (md.includes("I couldn't find any matches")) {
          return finalize("No matches found for rewrite rule.", false, { pruneKey });
        }
        const names = parseNumberedNames(ucmOutput(md));
        if (names.length === 0) {
          return finalize("No matches found for rewrite rule.", false, { pruneKey });
        }

        if (rewrite) {
          const count = names.length;
          const rewriteTranscript = await runTranscript({
            project: proj,
            code,
            commands: [
              `sfind ${ruleName}`,
              `edit 1-${count}`,
              `rewrite ${ruleName}`,
              `load`,
              `update`,
              `delete.term ${ruleName}`,
            ],
            captureRewrite: true,
            signal,
          });

          const dump = addedByUcm(rewriteTranscript.md);
          if (isIncompleteUpdate(rewriteTranscript.md) || dump) {
            const closure = rewriteTranscript.rewrittenCode || dump;
            const affected = await affectedUpdateNames(proj, signal);
            await cleanupPendingUpdate(proj, signal);
            const guidance =
              `Fix and resubmit EVERY affected definition together in one ` +
              `unison_update call. Do not filter the list by heuristics (e.g. ` +
              `assuming record accessors are auto-generated — they may be ` +
              `hand-written terms); anything on it with broken source must be ` +
              `included in the resubmission, and everything else on it rides ` +
              `along because UCM excises the whole closure.`;
            const parts = [
              `⚠ update incomplete on ${proj}: some existing definitions would no ` +
                `longer typecheck after this rewrite, so NOTHING was committed. The ` +
                `working branch has been rolled back to a clean state (pending merge ` +
                `cancelled, temporary \`update-*\` branch removed).`,
              `Two common causes:\n` +
                `  • The edited definition's TYPE SIGNATURE changed — often narrowed by ` +
                `inference (a dropped ability or parameter) — which breaks its callers. ` +
                `Retrieve the ORIGINAL signature with unison_dump and pin it explicitly.\n` +
                `  • You added a constructor to an ability, making its handlers ` +
                `non-exhaustive (add the missing cases).`,
            ];
            if (affected.length > 0) {
              parts.push(
                `Affected definitions (${affected.length}) — the authoritative set, ` +
                  `harvested from the staging branch before rollback:\n` +
                  affected.map((n) => `  ${n}`).join("\n"),
              );
              parts.push(guidance);
            }
            if (closure) {
              parts.push("```unison\n" + closure + "\n```");
            } else if (affected.length === 0) {
              parts.push(
                `(UCM emitted neither the affected-definition source nor a staging ` +
                  `branch to harvest names from; run unison_dump on the broken ` +
                  `dependents to retrieve re-loadable versions.)`,
              );
              parts.push(guidance);
            }
            return finalize(parts.join("\n\n"), true, {
              details: { affectedDefinitions: affected },
            });
          }

          if (rewriteTranscript.ok) {
            const s = defSummary(rewriteTranscript.md);
            s.added = s.added.filter((n) => n !== ruleName);
            s.modified = s.modified.filter((n) => n !== ruleName);
            const total = s.added.length + s.modified.length;
            const summary = total
              ? `✓ Rewrote and committed to ${proj}: ${s.modified.length} modified, ${s.added.length} added definitions (names only):\n${formatDefs(s)}`
              : ucmOutput(rewriteTranscript.md) || `✓ rewrite applied to ${proj}.`;
            return finalize(summary, false, {
              details: { modifiedDefinitions: s.modified, addedDefinitions: s.added },
            });
          }
          return finalize(errorText(rewriteTranscript.md), true);
        }

        const ucmBlocks = parseBlocks(md).filter((b) => b.info.startsWith("ucm"));
        if (ucmBlocks.length > 1) {
          const commandBlocks = ucmBlocks.slice(1);
          const stripped = commandBlocks
            .map((b) =>
              b.body
                .split("\n")
                .filter((l) => !/^\s*\S+\/\S+>\s/.test(l))
                .join("\n")
                .trim(),
            )
            .filter(Boolean)
            .join("\n\n")
            .trim();
          if (stripped) return finalize(stripped, false, { pruneKey });
        }
        return finalize(ucmOutput(md) || "(no matches found)", false, { pruneKey });
      });
    },

    /** Search or search-and-replace AST inside a scratch file (.u on disk). */
    async sfindScratch(
      scratchCode: string,
      ruleCode: string | undefined,
      ruleName: string,
      pruneKey: string,
      rewrite: boolean,
      commit: boolean,
      tempRuleAdded: boolean,
      scratchPath: string,
      signal?: AbortSignal,
      project?: string,
    ): Promise<UcmResult> {
      return serialize(async () => {
        const proj = target(project);
        const codeToSend =
          tempRuleAdded && ruleCode
            ? scratchCode.replace(/\s+$/, "") + "\n\n" + ruleCode.trim() + "\n"
            : scratchCode;

        if (!rewrite) {
          const { ok, md } = await runTranscript({
            project: proj,
            code: codeToSend,
            commands: [`rewrite ${ruleName}`],
            signal,
          });
          if (!ok) {
            const err = errorText(md);
            if (err.includes("I couldn't find any matches")) {
              return finalize(`No matches found in ${scratchPath} for rewrite rule \`${ruleName}\`.`, false, {
                pruneKey,
              });
            }
            return finalize(err, true, { pruneKey });
          }
          if (md.includes("I couldn't find any matches")) {
            return finalize(`No matches found in ${scratchPath} for rewrite rule \`${ruleName}\`.`, false, {
              pruneKey,
            });
          }
          const m = md.match(/I found and replaced matches in these definitions:\s*([^\n]+)/);
          const matchedDefs = m ? m[1].trim().split(/\s+/) : [];
          const text =
            matchedDefs.length > 0
              ? `Matches found in ${scratchPath} across definitions: ${matchedDefs.join(", ")}`
              : `Matches found in ${scratchPath} for rewrite rule \`${ruleName}\`.`;
          return finalize(text, false, { pruneKey, details: { matchedDefinitions: matchedDefs } });
        }

        const commands = commit
          ? [`rewrite ${ruleName}`, `load`, `update`]
          : [`rewrite ${ruleName}`, `load`];

        const { ok, md, rewrittenCode } = await runTranscript({
          project: proj,
          code: codeToSend,
          commands,
          captureRewrite: true,
          signal,
        });

        if (!ok) {
          const err = errorText(md);
          if (err.includes("I couldn't find any matches")) {
            return finalize(`No matches found in ${scratchPath} for rewrite rule \`${ruleName}\`.`, false, {
              pruneKey,
            });
          }
          return finalize(err, true, { pruneKey });
        }

        if (md.includes("I couldn't find any matches")) {
          return finalize(`No matches found in ${scratchPath} for rewrite rule \`${ruleName}\`.`, false, {
            pruneKey,
          });
        }

        const dump = addedByUcm(md);
        let rawRewritten = dump || rewrittenCode;
        if (!rawRewritten) {
          return finalize(`Could not capture rewritten code for ${scratchPath}.`, true, { pruneKey });
        }

        // Clean up UCM's leading rewrite metadata comments
        let finalCode = rawRewritten
          .replace(/^-- \| Rewrote using:[^\n]*\n(?:-- \| Modified definition\(s\):[^\n]*\n)?\n*/m, "")
          .trim();

        // Clean up temporary rule if it was appended inline
        if (tempRuleAdded) {
          const escapedRule = ruleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          finalCode = finalCode
            .replace(
              new RegExp(
                `(?:^[ \\t]*${escapedRule}\\s*:[\\s\\S]*?\\n)?^[ \\t]*${escapedRule}(\\s+[^=\\n]+)*\\s*=[\\s\\S]*?(?=\\n\\S|$)`,
                "m",
              ),
              "",
            )
            .trim();
        }

        // Preserve leading project header if present in original scratchCode
        const headerMatch = scratchCode.match(/^\s*--\s*@unison-project:\s*\S+/m);
        if (headerMatch && !finalCode.includes(headerMatch[0])) {
          finalCode = headerMatch[0] + "\n\n" + finalCode;
        }

        await writeFile(scratchPath, finalCode + "\n", "utf8");

        const m = md.match(/I found and replaced matches in these definitions:\s*([^\n]+)/);
        const matchedDefs = m ? m[1].trim().split(/\s+/) : [];

        if (commit) {
          const s = defSummary(md);
          s.added = s.added.filter((n) => n !== ruleName);
          s.modified = s.modified.filter((n) => n !== ruleName);
          const total = s.added.length + s.modified.length;
          const summary = total
            ? `✓ Rewrote ${scratchPath} in place and committed to ${proj}: ${s.modified.length} modified, ${s.added.length} added definitions (names only):\n${formatDefs(s)}`
            : `✓ Rewrote ${scratchPath} in place and committed to ${proj}.`;
          return finalize(summary, false, {
            details: { modifiedDefinitions: matchedDefs, committed: true },
          });
        }

        const defsStr = matchedDefs.length > 0 ? ` (replaced in: ${matchedDefs.join(", ")})` : "";
        const summary = `✓ Applied rewrite \`${ruleName}\` to ${scratchPath}${defsStr}.\n✓ ${scratchPath} typechecks cleanly.`;
        return finalize(summary, false, {
          details: { modifiedDefinitions: matchedDefs, committed: false },
        });
      });
    },

    /** Read-only codebase query (view / find / docs / ls / dependencies …). */
    async query(
      command: string,
      pruneKey: string,
      signal?: AbortSignal,
      project?: string,
    ): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript({
          project: target(project),
          commands: [command],
          signal,
        });
        return finalize(ok ? ucmOutput(md) || "(no results)" : errorText(md), !ok, { pruneKey });
      });
    },

    /** Run the project's test suite; return the results block. */
    async test(signal?: AbortSignal, project?: string): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript({
          project: target(project),
          commands: ["test"],
          signal,
        });
        return finalize(ok ? ucmOutput(md) : errorText(md), !ok);
      });
    },

    /** Codebase orientation: which codebase/project, and the available projects. */
    async status(signal?: AbortSignal): Promise<UcmResult> {
      return serialize(async () => {
        // NB: `defaultProject` may be a thunk — it must be RESOLVED here (via
        // `target()`), both for display and for the transcript prompt. Passing
        // the raw thunk used to stringify the function source into the output
        // and produce a broken transcript (empty project list).
        const proj = target();
        const { ok, md } = await runTranscript({
          project: proj,
          commands: ["projects"],
          signal,
        });
        const projects = ok ? ucmOutput(md) : errorText(md);
        return finalize(
          `Codebase: ${codebase ?? "(UCM default)"}\nDefault project/branch: ${proj}\n\nProjects:\n${projects}`,
          !ok,
        );
      });
    },

    /** Escape hatch: run one or more raw UCM commands. Not de-duplicated. */
    async raw(commands: string[], signal?: AbortSignal, project?: string): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript({
          project: target(project),
          commands,
          signal,
        });
        return finalize(ok ? ucmOutput(md) || "(no output)" : errorText(md), !ok);
      });
    },
  };
}

export type Ucm = ReturnType<typeof createUcm>;
