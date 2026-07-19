// Transcript-backed UCM driver.
//
// Everything routes through `ucm transcript.in-place`, which runs a markdown
// transcript against the real codebase and writes a clean, ANSI-free
// `<file>.output.md`. We parse THAT (not stdout) and return only the parts the
// model needs — the whole point of the token-reduction strategy (#3, "filter at
// the source"). Mutating runs are serialized through a promise queue because
// transcripts and any headless server share one SQLite codebase.

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
  /** project/branch the transcript stanzas run against (deps must resolve here). */
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
  info: string; // e.g. "unison", "ucm", "ucm :added-by-ucm", "" (plain)
  body: string;
}

function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^```(.*)$/);
    if (!open) {
      i++;
      continue;
    }
    const info = open[1].trim();
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    i++; // consume closing fence
    blocks.push({ info, body: body.join("\n").replace(/\s+$/, "") });
  }
  return blocks;
}

const FAILED = "The transcript failed due to an error";

/** Concatenated bodies of plain ``` blocks — where UCM puts compiler errors. */
function errorText(md: string): string {
  const plain = parseBlocks(md)
    .filter((b) => b.info === "")
    .map((b) => b.body.trim())
    .filter(Boolean);
  return (plain.join("\n\n") || md).trim();
}

/** Bodies of the `ucm` result blocks, with echoed `project/branch> cmd` prompt
 * lines stripped (the model already knows what it ran). */
function ucmOutput(md: string): string {
  return parseBlocks(md)
    .filter((b) => b.info.startsWith("ucm"))
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
  const { exec, codebase, project, timeoutMs } = config;

  async function runTranscript(
    transcript: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; md: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-ucm-"));
    const src = join(dir, "t.md");
    const out = join(dir, "t.output.md");
    try {
      await writeFile(src, transcript, "utf8");
      const args = [
        ...(codebase ? ["-c", codebase] : []),
        "transcript.in-place",
        src,
      ];
      await exec("ucm", args, { signal, timeout: timeoutMs });
      const md = await readFile(out, "utf8").catch(() => "");
      return { ok: !md.includes(FAILED), md };
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

  const codeStanza = (code: string) => "```unison\n" + code.replace(/\s+$/, "") + "\n```\n";
  const cmdStanza = (...cmds: string[]) =>
    "```ucm\n" + cmds.map((c) => `${project}> ${c}`).join("\n") + "\n```\n";

  return {
    /** Typecheck source without committing. Returns only diagnostics. */
    async typecheck(code: string, pruneKey: string, signal?: AbortSignal): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript(codeStanza(code), signal);
        if (!ok) return finalize(errorText(md), true, { pruneKey });
        const defs = newDefinitions(md);
        const summary = defs.length
          ? `✓ Typechecks. ${defs.length} definition(s):\n  ${defs.join("\n  ")}`
          : "✓ Typechecks (no new/changed definitions).";
        return finalize(summary, false, { pruneKey });
      });
    },

    /** Typecheck + commit in ONE transcript (one round trip, strategy #4). */
    async update(code: string, signal?: AbortSignal): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript(codeStanza(code) + cmdStanza("update"), signal);
        if (!ok) return finalize(errorText(md), true);
        const defs = newDefinitions(md);
        const summary = defs.length
          ? `✓ Committed ${defs.length} definition(s):\n  ${defs.join("\n  ")}`
          : ucmOutput(md) || "✓ update applied.";
        return finalize(summary, false);
      });
    },

    /** Read-only codebase query (view / find / docs / ls / dependencies …). */
    async query(
      command: string,
      pruneKey: string,
      signal?: AbortSignal,
    ): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript(cmdStanza(command), signal);
        return finalize(ok ? ucmOutput(md) : errorText(md), !ok, { pruneKey });
      });
    },

    /** Run the project's test suite; return the results block. */
    async test(signal?: AbortSignal): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript(cmdStanza("test"), signal);
        return finalize(ok ? ucmOutput(md) : errorText(md), !ok);
      });
    },

    /** Escape hatch: run one or more raw UCM commands. Not de-duplicated. */
    async raw(commands: string[], signal?: AbortSignal): Promise<UcmResult> {
      return serialize(async () => {
        const { ok, md } = await runTranscript(cmdStanza(...commands), signal);
        return finalize(ok ? ucmOutput(md) : errorText(md), !ok);
      });
    },
  };
}

export type Ucm = ReturnType<typeof createUcm>;
