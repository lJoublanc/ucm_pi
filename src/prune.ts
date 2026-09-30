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

const STUB =
  "[superseded by a newer result for the same target — re-run the tool if you need it again]";

/**
 * A pruned message must leave nothing extractable behind. Takes either an
 * AgentMessage-shaped object or a tool_result event payload. Both `content`
 * and `structuredContent` are cleared: the agent loop keeps `structuredContent`
 * only when `content` is untouched, so clearing `content` alone silently drops
 * the structured half, and a handler reacting after us reads the event, not the
 * message. `details.pruneKey` is kept — it is a small dedupe id, not payload.
 */
export function stubPrunedResult<T extends { content?: unknown; structuredContent?: unknown }>(
  m: T,
): T {
  if (Array.isArray(m.content)) m.content = [{ type: "text", text: STUB }];
  if ("structuredContent" in m) m.structuredContent = { stubbed: true };
  return m;
}

export function pruneStaleUnisonResults(messages: any[]): any[] {
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "toolResult") continue;
    const key: unknown = m.details?.pruneKey;
    if (typeof key !== "string") continue; // only tools that opted in
    if (seen.has(key)) {
      stubPrunedResult(m);
    } else {
      seen.add(key);
    }
  }
  return messages;
}
