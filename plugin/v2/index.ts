/**
 * ai-ship native plugin for OpenCode 2.x (verified against opencode-cli 2.3.0).
 *
 * Install: `ai-ship --plugin-install` (or copy the built bundle to ~/.config/opencode/plugins/ai-ship.js).
 * 2.x plugins must default-export `{ id, setup(ctx) }`; the 1.x `Plugin` function format is rejected.
 *
 * Commands run inside the OpenCode server process. `/ship` starts the pipeline in the background and returns
 * at once; every agent appears as a live child ("subagent") session of a `ship: <task>` session.
 */
import { loadRepoConfig, parseCliArgs } from "../../src/config.ts";
import { listCleanupTargets, openPrFromWorktree, removeCleanupTargets } from "../../src/git.ts";
import { appendMemory, forgetMemory } from "../../src/memory.ts";
import { parseNotyAddress, resolveNotyTask } from "../../src/noty.ts";
import { createCtxApi, type Oc2PluginCtxLike } from "../../src/oc2/api.ts";
import { createLazyRunner, createOc2Runner } from "../../src/oc2/runner.ts";
import { formatPipelineResult, runPipeline } from "../../src/pipeline.ts";
import { formatProgressEvent, type ProgressEvent } from "../../src/progress.ts";
import { formatSafetyFindings, scanWorktreeSafety } from "../../src/safety.ts";
import { formatDoctor, initRepo, isSupportedOpencodeVersion, runDoctor } from "../../src/doctor.ts";
import path from "node:path";

export interface PluginCommandInput {
  sessionID: string;
  prompt: { text: string };
}

export interface PluginCtx extends Oc2PluginCtxLike {
  location?: { directory?: string };
  app?: { name?: string; version?: string };
  command: {
    transform(fn: (reg: { add(cmd: { name: string; description: string; execute: (i: PluginCommandInput) => Promise<string> }): void }) => void): Promise<unknown> | unknown;
  };
}

export interface ShipJob {
  id: string;
  task: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  cancelled?: boolean;
  startedAt: number;
  events: ProgressEvent[];
  result?: string;
  error?: string;
  shipSessionId?: string;
  cancel?: () => Promise<void>;
}

const MAX_EVENTS = 200;

/** Splits command arguments like a shell would for simple cases ("quoted text" and 'quotes'). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function createAiShipV2Plugin(deps: {
  runPipeline?: typeof runPipeline;
  now?: () => number;
} = {}) {
  const run = deps.runPipeline ?? runPipeline;
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, ShipJob>();
  let nextJob = 1;

  const setup = async (ctx: PluginCtx) => {
    const repoDir = () => ctx.location?.directory ?? process.cwd();
    if (ctx.app?.version && !isSupportedOpencodeVersion(ctx.app.version)) {
      console.warn(`[ai-ship] OpenCode ${ctx.app.version} is outside the supported range (>=2.3 <3); run /ship-doctor.`);
    }

    const ship = async (input: PluginCommandInput): Promise<string> => {
      const parsed = parseCliArgs(splitArgs(input.prompt.text), repoDir());
      if (parsed.unknownOption) return `ai-ship: unknown option ${parsed.unknownOption}`;
      let task = parsed.positional.join(" ").trim();
      if (parseNotyAddress(task) || parsed.notyAddress) {
        task = resolveNotyTask(parsed.notyAddress ?? task, parsed.notyDir).task;
      }
      if (!task) return "ai-ship: usage /ship <task or noty://item/...> [--pr] [--draft] [--skip-tests] [--skip-review] [--model p/m]";

      const job: ShipJob = { id: `job-${nextJob++}`, task, status: "running", startedAt: now(), events: [] };
      jobs.set(job.id, job);
      // Keep at most 20 jobs, evicting the oldest finished ones first (running jobs stay visible).
      for (const [id, j] of jobs) {
        if (jobs.size <= 20) break;
        if (j.status !== "running") jobs.delete(id);
      }
      const onEvent = (e: ProgressEvent) => {
        job.events.push(e);
        if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
      };
      const notify = async (text: string) => {
        try {
          await ctx.session.synthetic?.({ sessionID: input.sessionID, text, resume: false, description: "ai-ship" });
        } catch {
          // best effort: status is also available via /ship-status
        }
      };
      const config = loadRepoConfig(parsed.repoDir);
      let oc2: ReturnType<typeof createOc2Runner> | undefined;
      const lazy = createLazyRunner((dir) => {
        oc2 = createOc2Runner({
          api: createCtxApi(ctx),
          worktreeDir: dir,
          config,
          task,
          roleModels: {
            implementer: parsed.model,
            tester: parsed.testerModel,
            reviewer: parsed.reviewerModel,
            bughunter: parsed.bughunterModel,
          },
          onEvent,
        });
        if (job.cancelled) void oc2.cancel();
        return oc2;
      });
      job.cancel = async () => {
        // Job-level flag: stops the pipeline between stages (incl. before commit/PR) even when no agent is running.
        job.cancelled = true;
        if (oc2) await oc2.cancel();
      };

      // Fire and forget: the command returns immediately; progress lives in the child sessions.
      void run({
        repoDir: parsed.repoDir,
        task,
        openPr: parsed.openPr,
        draft: parsed.draft,
        skipTests: parsed.skipTests,
        skipReview: parsed.skipReview,
        skipBughunter: parsed.skipBughunter,
        allowConfigChange: parsed.allowConfigChange,
        model: parsed.model,
        testerModel: parsed.testerModel,
        reviewerModel: parsed.reviewerModel,
        bughunterModel: parsed.bughunterModel,
        runner: lazy.runner,
        onWorktree: lazy.onWorktree,
        onEvent,
        isCancelled: () => Boolean(job.cancelled),
      })
        .then(async (result) => {
          job.status = "succeeded";
          job.result = formatPipelineResult(result, task, parsed.openPr);
          await notify(`ai-ship ${job.id} finished\n\n${job.result}`);
        })
        .catch(async (err: unknown) => {
          job.status = job.cancelled ? "cancelled" : "failed";
          job.error = err instanceof Error ? err.message : String(err);
          await notify(`ai-ship ${job.id} failed: ${job.error.slice(0, 2000)}`);
        })
        .finally(() => {
          job.shipSessionId = oc2?.shipSessionId();
        });

      const started = `ai-ship ${job.id} started: ${task.split(/\r?\n/)[0].slice(0, 80)}\nEach agent runs as a live subagent session under "ship: …". Use /ship-status ${job.id} for a summary.`;
      await notify(started);
      return started;
    };

    const status = async (input: PluginCommandInput): Promise<string> => {
      const reply = await statusText(input);
      try {
        await ctx.session.synthetic?.({ sessionID: input.sessionID, text: reply, resume: false, description: "ai-ship" });
      } catch {
        // ignore
      }
      return reply;
    };
    const statusText = async (input: PluginCommandInput): Promise<string> => {
      const id = input.prompt.text.trim();
      const list = id ? [jobs.get(id)].filter((j): j is ShipJob => Boolean(j)) : [...jobs.values()].slice(-5);
      if (list.length === 0) return id ? `ai-ship: no job ${id}` : "ai-ship: no jobs yet";
      return list
        .map((j) => {
          const tail = j.events.slice(-8).map(formatProgressEvent).join("\n");
          const body = j.status === "running" ? tail : j.result ?? j.error ?? "";
          return `## ${j.id} — ${j.status} — ${j.task.split(/\r?\n/)[0].slice(0, 80)}\n${body}`;
        })
        .join("\n\n");
    };

    const commands: Array<{ name: string; description: string; execute: (i: PluginCommandInput) => Promise<string> }> = [
      { name: "ship", description: "Run the ai-ship pipeline (worktree → implement → independent tests → verify → reviews) in the background", execute: ship },
      { name: "ship-status", description: "Show ai-ship job status and recent per-agent progress", execute: status },
      {
        name: "ship-cancel",
        description: "Cancel a running ai-ship job: interrupts its agent sessions and keeps the worktree",
        execute: async (i) => {
          const id = i.prompt.text.trim() || [...jobs.values()].reverse().find((j) => j.status === "running")?.id;
          const job = id ? jobs.get(id) : undefined;
          if (!job) return "ai-ship: no running job to cancel";
          if (job.status !== "running") return `ai-ship ${job.id} is already ${job.status}`;
          await job.cancel?.();
          return `ai-ship ${job.id}: cancel requested (agent sessions interrupted; the worktree is kept).`;
        },
      },
      {
        name: "ship-init",
        description: "Copy starter AGENTS.md and .ai-ship.json into this repo (never overwrites)",
        execute: async () => initRepo(repoDir(), path.resolve(import.meta.dirname, "..", "..", "templates")).join("\n"),
      },
      {
        name: "ship-doctor",
        description: "Check the ai-ship native-plugin setup; --fix removes a duplicate ai-ship MCP server (with backup)",
        execute: async (i) =>
          formatDoctor(runDoctor({ opencodeVersion: ctx.app?.version, fix: splitArgs(i.prompt.text).includes("--fix") })),
      },
      {
        name: "remember",
        description: "Save a note to ai-ship repo memory",
        execute: async (i) => {
          const text = i.prompt.text.trim();
          if (!text) return "ai-ship: usage /remember <fact>";
          const res = appendMemory(repoDir(), text, "note");
          return res.added ? `Saved to repo memory (${res.path}).` : "Already in repo memory.";
        },
      },
      {
        name: "forget",
        description: "Remove matching notes from ai-ship repo memory",
        execute: async (i) => {
          const res = forgetMemory(repoDir(), i.prompt.text);
          return `Removed ${res.removedCount} matching entry(s) from ${res.path}.`;
        },
      },
      {
        name: "cleanup",
        description: "List (or with --yes remove) leftover ai-ship worktrees and ai/* branches; --force includes dirty/unmerged",
        execute: async (i) => {
          const args = splitArgs(i.prompt.text);
          const targets = listCleanupTargets(repoDir());
          const summary = `Worktrees: ${targets.worktrees.map((w) => w.path).join(", ") || "(none)"}\nBranches: ${targets.branches.map((b) => b.name).join(", ") || "(none)"}`;
          if (!args.includes("--yes") && !args.includes("-y")) return `Dry run (add --yes to remove):\n${summary}`;
          const r = removeCleanupTargets(targets, { force: args.includes("--force") });
          return `Removed ${r.removedWorktrees.length} worktree(s), ${r.removedBranches.length} branch(es). Kept: ${[...r.skippedWorktrees, ...r.skippedBranches].join(", ") || "none"}.`;
        },
      },
      {
        name: "safety-check",
        description: "Scan the repo diff and untracked files for leaked secrets, deployment IDs, keys and emails",
        execute: async () => {
          const cfg = loadRepoConfig(repoDir());
          return formatSafetyFindings(scanWorktreeSafety(repoDir(), { baseBranch: cfg.baseBranch, allowlist: cfg.safetyAllowlist }).findings);
        },
      },
      {
        name: "pr",
        description: "Rebase, push and open a PR for an ai-ship worktree: /pr <title> [--draft]",
        execute: async (i) => {
          const res = openPrFromWorktree({ repoDir: repoDir(), title: i.prompt.text });
          return `Opened ${res.draft ? "draft PR" : "PR"} for ${res.branch}: ${res.prUrl ?? "(created)"}`;
        },
      },
    ];

    await ctx.command.transform((reg) => {
      for (const c of commands) {
        reg.add({
          ...c,
          execute: async (i) => {
            try {
              return await c.execute(i);
            } catch (err) {
              return `ai-ship ${c.name} failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        });
      }
    });
  };

  return { id: "ai-ship", setup, jobs };
}

const plugin = createAiShipV2Plugin();
export default { id: plugin.id, setup: plugin.setup };
