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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

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
  /** Default project/branch operations run against when a call omits one. */
  project: string;
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

function newDefinitions(md: string): string[] {
  const defs: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*[+⍟]\s+(.+?)\s+:\s+(.+?)\s*$/);
    if (m) defs.push(`${m[1]} : ${m[2]}`);
  }
  return defs;
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
    signal?: AbortSignal;
  }

  async function runTranscript(opts: RunOpts): Promise<{ ok: boolean; md: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-ucm-"));
    const src = join(dir, "t.md");
    const out = join(dir, "t.output.md");
    try {
      const prompts: string[] = [];
      if (opts.code !== undefined) {
        const codePath = join(dir, "code.u");
        await writeFile(codePath, opts.code.replace(/\s+$/, "") + "\n", "utf8");
        prompts.push(`${opts.project}> load ${codePath}`);
      }
      for (const c of opts.commands ?? []) prompts.push(`${opts.project}> ${c}`);
      const transcript = "```ucm\n" + prompts.join("\n") + "\n```\n";
      await writeFile(src, transcript, "utf8");
      const args = [...(codebase ? ["-c", codebase] : []), "transcript.in-place", src];
      await exec("ucm", args, { signal: opts.signal, timeout: timeoutMs });
      const md = await readFile(out, "utf8").catch(() => "");
      return { ok: md !== "" && !md.includes(FAILED), md };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
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

  const target = (project?: string) => project?.trim() || defaultProject;

  return {
    /** The resolved codebase + default project, for status/introspection. */
    describe() {
      return { codebase: codebase ?? "(UCM default)", project: defaultProject };
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
        const defs = newDefinitions(md);
        const summary = defs.length
          ? `✓ Typechecks against ${proj}. ${defs.length} definition(s):\n  ${defs.join("\n  ")}`
          : `✓ Typechecks against ${proj} (no new/changed definitions).`;
        return finalize(summary, false, { pruneKey });
      });
    },

    /** Typecheck + commit in ONE transcript (one round trip, strategy #4).
     * On a partial failure UCM leaves the affected definitions to be fixed; we
     * surface that canonical, re-loadable source so the caller can edit and
     * re-run instead of reconstructing it by hand. */
    async update(code: string, signal?: AbortSignal, project?: string): Promise<UcmResult> {
      return serialize(async () => {
        const proj = target(project);
        const { ok, md } = await runTranscript({
          project: proj,
          code,
          commands: ["update"],
          signal,
        });
        if (ok) {
          const defs = newDefinitions(md);
          const summary = defs.length
            ? `✓ Committed to ${proj}. ${defs.length} definition(s):\n  ${defs.join("\n  ")}`
            : ucmOutput(md) || `✓ update applied to ${proj}.`;
          return finalize(summary, false);
        }
        const dump = addedByUcm(md);
        if (dump) {
          const text =
            `⚠ update incomplete on ${proj}: some existing definitions no longer ` +
            `typecheck after this change (e.g. an ability gained a constructor, so ` +
            `its handlers are non-exhaustive). UCM staged the change on a temporary ` +
            `branch and wrote the FULL affected-definition closure below — this is ` +
            `canonical, re-loadable source. Fix it (add the missing cases, etc.) and ` +
            `call unison_update again with the corrected source to complete the merge.\n\n` +
            "```unison\n" +
            dump +
            "\n```";
          return finalize(text, true);
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
        const d = { codebase: codebase ?? "(UCM default)", project: defaultProject };
        const { ok, md } = await runTranscript({
          project: defaultProject,
          commands: ["projects"],
          signal,
        });
        const projects = ok ? ucmOutput(md) : errorText(md);
        return finalize(
          `Codebase: ${d.codebase}\nDefault project/branch: ${d.project}\n\nProjects:\n${projects}`,
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
