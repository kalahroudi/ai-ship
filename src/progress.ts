/** Normalized, per-agent progress events emitted while ai-ship runs (shared by CLI, MCP and the plugin). */
export interface ProgressEvent {
  ts: number;
  /** Pipeline stage label, e.g. "Stage 4: Security Lens". */
  stage?: string;
  role?: string;
  sessionId?: string;
  /** Session title, e.g. "Review (Security)". */
  agent?: string;
  model?: string;
  kind: "stage" | "session" | "tool" | "text" | "usage" | "verdict" | "stall" | "error" | "done";
  text: string;
}

export type ProgressSink = (event: ProgressEvent) => void;

/** One-line rendering used by the CLI and MCP log notifications. */
export function formatProgressEvent(e: ProgressEvent): string {
  const who = e.agent ?? e.role ?? "ai-ship";
  return `[${who}] ${e.kind === "tool" ? "→ " : ""}${e.text}`;
}

/**
 * Throttles a sink: at most one event per `intervalMs` per (agent, kind), always passing
 * stage/session/verdict/error/done events through. Coalesced events are dropped, not queued.
 */
export function throttleSink(sink: ProgressSink, intervalMs = 1000, now: () => number = Date.now): ProgressSink {
  const last = new Map<string, number>();
  return (e) => {
    if (e.kind === "stage" || e.kind === "session" || e.kind === "verdict" || e.kind === "error" || e.kind === "done") {
      sink(e);
      return;
    }
    const key = `${e.sessionId ?? e.agent ?? ""}:${e.kind}`;
    const t = now();
    if (t - (last.get(key) ?? -Infinity) < intervalMs) return;
    last.set(key, t);
    sink(e);
  };
}

/** Describes a tool content part for progress output, e.g. `read src/a.ts` or `shell npm test`. */
export function describeToolPart(part: { name?: string; state?: unknown }): string {
  const state = (part.state ?? {}) as { status?: string; input?: Record<string, unknown>; title?: string };
  const input = state.input ?? {};
  const detail =
    (typeof state.title === "string" && state.title) ||
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.command === "string" && input.command) ||
    (typeof input.pattern === "string" && input.pattern) ||
    "";
  return `${part.name ?? "tool"}${detail ? ` ${String(detail).slice(0, 80)}` : ""}${state.status ? ` (${state.status})` : ""}`;
}
