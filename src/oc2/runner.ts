import type { RepoConfig } from "../config.ts";
import { loadPricingTable, type PricingTable } from "../pricing.ts";
import { describeToolPart, type ProgressSink } from "../progress.ts";
import {
  addUsage,
  applyPricing,
  assertNonEmptyReadOnlyReply,
  classifyProviderError,
  formatUsageSummary,
  isReadOnlyRole,
  resolveRoleModelLabels,
  type AgentRole,
  type PipelineRunner,
  type PromptOptions,
  type PromptResult,
  type PromptUsage,
  type RoleModelOverrides,
} from "../runner.ts";
import type { Oc2Api, Oc2Message, Oc2ModelRef } from "./api.ts";

/**
 * PipelineRunner on top of an OpenCode 2.x server (plugin context or REST).
 *
 * Every pipeline agent becomes a CHILD session of one "ship: <task>" parent session created at the worktree
 * location, so OpenCode Desktop shows each agent live as a subagent (tool calls, edits, reasoning) and the
 * parent receives a `<subagent>` report after each round. Child sessions are created lazily on their first
 * prompt so the role's agent and model can be set at creation time.
 */
export function createOc2Runner(opts: {
  api: Oc2Api;
  worktreeDir: string;
  config: RepoConfig;
  task: string;
  roleModels?: RoleModelOverrides;
  /** Existing parent session to attach agents to (it must be located in the worktree). */
  parentSessionId?: string;
  onEvent?: ProgressSink;
  pricing?: PricingTable;
  pollMs?: number;
  /** Max time one agent turn may run before it is interrupted (default config.agentTimeoutMs or 30 min). */
  turnTimeoutMs?: number;
}): PipelineRunner & { shipSessionId(): string | undefined; cancel(): Promise<void>; isCancelled(): boolean } {
  const turnTimeoutMs = opts.turnTimeoutMs ?? opts.config.agentTimeoutMs ?? 30 * 60_000;
  const pricing = opts.pricing ?? loadPricingTable(opts.config.pricing);
  const labels = resolveRoleModelLabels("opencode", opts.config, opts.roleModels ?? {});
  const pollMs = opts.pollMs ?? 2000;
  let shipId = opts.parentSessionId;
  let shipCreating: Promise<string> | undefined;
  let agentNames: string[] | undefined;
  const sessions = new Map<string, { title: string; realId?: string; creating?: Promise<string>; turns: number }>();
  let nextLocal = 1;
  const emit = opts.onEvent ?? (() => undefined);
  let cancelled = false;

  const toRef = (label?: string): Oc2ModelRef | undefined => {
    if (!label) return undefined;
    const i = label.indexOf("/");
    if (i > 0) return { providerID: label.slice(0, i), id: label.slice(i + 1) };
    emit({ ts: Date.now(), kind: "error", text: `model "${label}" has no provider prefix (provider/model); using the server default` });
    return undefined;
  };

  const ensureShip = async (): Promise<string> => {
    if (shipId) return shipId;
    shipCreating ??= opts.api
      .createSession({ title: `ship: ${opts.task.split(/\r?\n/)[0].slice(0, 60)}`, directory: opts.worktreeDir })
      .then((s) => {
        shipId = s.id;
        emit({ ts: Date.now(), kind: "session", sessionId: s.id, agent: "ship", text: `ship session ${s.id}` });
        return s.id;
      })
      .catch((err: unknown) => {
        shipCreating = undefined; // allow a retry
        throw err;
      });
    return shipCreating;
  };

  const agentFor = async (role: AgentRole): Promise<string | undefined> => {
    const configured = opts.config.oc2Agents?.[role];
    if (configured) return configured;
    if (!isReadOnlyRole(role)) return undefined;
    // Prefer a read-only built-in ("plan") for reviewers when the server has one.
    if (agentNames === undefined) {
      try {
        agentNames = (await opts.api.agents?.(opts.worktreeDir)) ?? [];
      } catch {
        agentNames = [];
      }
    }
    return agentNames.includes("plan") ? "plan" : undefined;
  };

  const realSession = async (localId: string, role: AgentRole, model?: Oc2ModelRef): Promise<string> => {
    const entry = sessions.get(localId);
    if (!entry) throw new Error(`Unknown ai-ship session ${localId}`);
    if (entry.realId) return entry.realId;
    entry.creating ??= (async () => {
      const parentID = await ensureShip();
      const agent = await agentFor(role);
      const s = await opts.api.createSession({ title: entry.title, parentID, agent, model, directory: opts.worktreeDir });
      entry.realId = s.id;
      emit({ ts: Date.now(), kind: "session", role, sessionId: s.id, agent: entry.title, model: model ? `${model.providerID}/${model.id}` : undefined, text: `started (${role})` });
      return s.id;
    })().catch((err: unknown) => {
      entry.creating = undefined; // allow a retry
      throw err;
    });
    return entry.creating;
  };

  const collect = (all: Oc2Message[], userMsgId: string) => {
    const idx = all.findIndex((m) => m.id === userMsgId);
    // Unknown prompt message: report nothing rather than re-counting older turns.
    const after = idx >= 0 ? all.slice(idx + 1) : [];
    const assistants = after.filter((m) => m.type === "assistant");
    const textOf = (m: Oc2Message) =>
      (m.content ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n");
    const last = [...assistants].reverse().find((m) => textOf(m).trim());
    let usage: PromptUsage | undefined;
    let anyCost = false;
    for (const m of assistants) {
      const t = m.tokens ?? {};
      if ((m.cost ?? 0) > 0) anyCost = true;
      usage = addUsage(usage, {
        input: t.input ?? 0,
        output: t.output ?? 0,
        reasoning: t.reasoning ?? 0,
        cacheRead: t.cache?.read ?? 0,
        cacheWrite: t.cache?.write ?? 0,
        costUsd: m.cost ?? 0,
        costSource: "provider",
      });
    }
    if (usage) usage.costSource = anyCost ? "provider" : "unknown";
    const model = [...assistants].reverse().find((m) => m.model)?.model;
    const outcome = after.find((m) => m.type === "idle")?.outcome;
    const errMsg = after
      .map((m) => m.error)
      .filter((e) => e !== undefined && e !== null)
      .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
      .join("; ")
      .slice(0, 500);
    return {
      text: last ? textOf(last).trim() : "",
      usage,
      model: model ? `${model.providerID}/${model.id}` : undefined,
      outcome,
      ...(errMsg ? { error: errMsg } : {}),
      assistants,
    };
  };

  const fallbackFor = (role: AgentRole): Oc2ModelRef | undefined => {
    const ref =
      role === "implementer"
        ? opts.config.implementerFallbackModel
        : role === "tester"
          ? opts.config.testerFallbackModel
          : role === "bughunter"
            ? opts.config.bughunterFallbackModel
            : opts.config.reviewerFallbackModel;
    return ref ? { providerID: ref.providerID, id: ref.id } : undefined;
  };

  const runTurn = async (sessionID: string, role: AgentRole, title: string, text: string, model?: Oc2ModelRef): Promise<PromptResult> => {
      if (cancelled) throw new Error("ai-ship run was cancelled");
      const user = await opts.api.prompt(sessionID, text, opts.worktreeDir);

      // Stream progress while waiting: report each new tool part once.
      const seen = new Set<string>();
      let done = false;
      const poller = (async () => {
        while (!done) {
          await new Promise((r) => setTimeout(r, pollMs));
          if (done) break;
          try {
            const { assistants } = collect(await opts.api.messages(sessionID, opts.worktreeDir), user.id);
            assistants.forEach((m, mi) =>
              (m.content ?? []).forEach((p, pi) => {
                if (p.type !== "tool") return;
                const key = `${mi}:${pi}:${(p.state as { status?: string } | undefined)?.status ?? ""}`;
                if (seen.has(key)) return;
                seen.add(key);
                emit({ ts: Date.now(), kind: "tool", role, sessionId: sessionID, agent: title, text: describeToolPart(p) });
              })
            );
          } catch {
            // progress is best-effort
          }
        }
      })();
      try {
        await opts.api.wait(sessionID, opts.worktreeDir, { timeoutMs: turnTimeoutMs });
      } catch (err) {
        // Stop the agent so it cannot keep editing the worktree after the pipeline moves on.
        try {
          await opts.api.interrupt?.(sessionID, opts.worktreeDir);
        } catch {
          // ignore
        }
        emit({ ts: Date.now(), kind: "error", role, sessionId: sessionID, agent: title, text: `interrupted: ${(err as Error).message}` });
        throw err;
      } finally {
        done = true;
        await poller;
      }

      const all = await opts.api.messages(sessionID, opts.worktreeDir);
      if (!all.some((m) => m.id === user.id)) {
        throw new Error(`OpenCode ${role} session ${sessionID}: prompt message ${user.id} not found in the session history`);
      }
      const res = collect(all, user.id);
      if (res.outcome && res.outcome !== "succeeded") {
        // Include the provider error so 429/5xx failures can be classified as transient.
        const detail = res.error ? `: ${res.error}` : "";
        throw new Error(`OpenCode ${role} session ${sessionID} ended with outcome "${res.outcome}"${detail}`);
      }
      const base: PromptResult = {
        text: res.text,
        usageSummary: res.usage ? formatUsageSummary(res.usage) : "completed",
        ...(res.usage ? { usage: res.usage } : {}),
      };
      const priced = applyPricing(base, res.model ?? (model ? `${model.providerID}/${model.id}` : undefined), pricing);
      emit({ ts: Date.now(), kind: "done", role, sessionId: sessionID, agent: title, text: priced.usageSummary });
      return assertNonEmptyReadOnlyReply(role, priced);
    };

  return {
    shipSessionId: () => shipId,
    isCancelled: () => cancelled,
    /** Stops the run: interrupts every agent session and makes further prompts fail. */
    async cancel(): Promise<void> {
      cancelled = true;
      const ids = [...sessions.values()].map((s) => s.realId).filter((id): id is string => Boolean(id));
      await Promise.all(
        ids.map(async (id) => {
          try {
            await opts.api.interrupt?.(id, opts.worktreeDir);
          } catch {
            // ignore
          }
        })
      );
      emit({ ts: Date.now(), kind: "error", agent: "ship", text: `cancelled (${ids.length} agent session(s) interrupted)` });
    },
    async createSession(title: string): Promise<string> {
      const id = `oc2-local-${nextLocal++}`;
      sessions.set(id, { title, turns: 0 });
      return id;
    },
    async prompt(localId: string, role: AgentRole, text: string, promptOpts?: PromptOptions): Promise<PromptResult> {
      if (cancelled) throw new Error("ai-ship run was cancelled");
      const override = promptOpts?.modelOverride;
      const model = override ? { providerID: override.providerID, id: override.modelID } : toRef(labels[role]);
      const sessionID = await realSession(localId, role, model);
      const entry = sessions.get(localId);
      const title = entry?.title ?? role;
      const firstTurn = (entry?.turns ?? 0) === 0;
      if (entry) entry.turns += 1;
      try {
        return await runTurn(sessionID, role, title, text, model);
      } catch (err) {
        // 2.x sessions have a fixed model, so failover = a fresh child session on the role's fallback model.
        const info = classifyProviderError(err);
        const fb = fallbackFor(role);
        const same = fb && model && fb.providerID === model.providerID && fb.id === model.id;
        if (cancelled || override || !info.transient || !fb || same || !entry) throw err;
        const from = model ? `${model.providerID}/${model.id}` : "(default)";
        const to = `${fb.providerID}/${fb.id}`;
        emit({ ts: Date.now(), kind: "error", role, sessionId: sessionID, agent: title, text: `${info.reason} on ${from}; failing over to ${to}` });
        entry.realId = undefined;
        entry.creating = undefined;
        entry.title = `${title} (fallback)`;
        const fbSession = await realSession(localId, role, fb);
        // The fallback session has no history: point a mid-conversation handover at the current worktree state.
        const handover = firstTurn
          ? text
          : `You are taking over from another agent whose model failed. Inspect the current worktree state (git status / git diff) before acting.\n\n${text}`;
        const res = await runTurn(fbSession, role, entry.title, handover, fb);
        return { ...res, fallback: { role, from, to, reason: info.reason } };
      }
    },
    async compact(localId: string): Promise<boolean> {
      const real = sessions.get(localId)?.realId;
      if (!real || !opts.api.compact) return false;
      try {
        await opts.api.compact(real, opts.worktreeDir);
        return true;
      } catch {
        return false;
      }
    },
    close() {},
  };
}

/**
 * A PipelineRunner whose real runner is built once the pipeline has created the worktree (pass the returned
 * `onWorktree` to runPipeline). Used by `--attach` and the native plugin.
 */
export function createLazyRunner(build: (worktreeDir: string) => PipelineRunner): {
  runner: PipelineRunner;
  onWorktree: (worktreeDir: string) => void;
} {
  let worktree: string | undefined;
  let inner: PipelineRunner | undefined;
  const get = () => {
    if (!worktree) throw new Error("ai-ship: runner used before the worktree was created");
    inner ??= build(worktree);
    return inner;
  };
  return {
    onWorktree: (dir) => {
      worktree = dir;
    },
    runner: {
      createSession: (title) => get().createSession(title),
      prompt: (sid, role, text, o) => get().prompt(sid, role, text, o),
      compact: async (sid, role) => (inner?.compact ? inner.compact(sid, role) : false),
      close: () => inner?.close(),
    },
  };
}
