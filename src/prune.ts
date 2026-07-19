// Strategy #1 — the biggest win.
//
// MCP re-sends every accumulated tool result on every turn, forever. A
// `view List.map` from 20 turns ago, or a superseded typecheck, is pure waste.
// We can't fix that in MCP; here we can. The `context` event fires before each
// LLM call with a mutable copy of the messages, so we walk it newest-first and
// stub out any read-only Unison result that has since been superseded by a newer
// result with the same `pruneKey` (e.g. "typecheck:/abs/scratch.u").
//
// Only idempotent, re-runnable read tools are pruned. Mutations (update, raw,
// test, run) are never touched — their history can be semantically important.

const STUB = "[superseded by a newer result for the same target — re-run the tool if you need it again]";

export function pruneStaleUnisonResults(messages: any[]): any[] {
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "toolResult") continue;
    const key: unknown = m.details?.pruneKey;
    if (typeof key !== "string") continue; // only tools that opted in
    if (seen.has(key)) {
      m.content = [{ type: "text", text: STUB }];
    } else {
      seen.add(key);
    }
  }
  return messages;
}
