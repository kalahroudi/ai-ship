import { listCleanupTargets, removeCleanupTargets } from "../src/git.ts";
import { appendMemory, forgetMemory, readMemory } from "../src/memory.ts";
import { runDreamConsolidation, runPipeline } from "../src/pipeline.ts";
import type { OpencodeClient } from "../src/runner.ts";

export interface ToolExecContext {
  directory: string;
  worktree: string;
  metadata?: (input: { title?: string; metadata?: Record<string, any> }) => void;
}

export interface ToolHelper {
  <Args extends Record<string, any>>(input: {
    description: string;
    args: Args;
    execute(args: any, context: ToolExecContext): Promise<string>;
  }): any;
  schema: {
    string(): any;
    boolean(): any;
  };
}

function notifyProgress(
  client: OpencodeClient,
  toolCtx: ToolExecContext,
  title: string,
  variant: "info" | "success" = "info"
): void {
  toolCtx.metadata?.({ title });
  const tui = (client as unknown as { tui?: { showToast?: (opts: any) => Promise<unknown> } }).tui;
  tui?.showToast?.({ body: { title: "ai-ship", message: title, variant } }).catch(() => undefined);
}

/**
 * Creates the `ai-ship` OpenCode plugin providing:
 * - Isolated worktree delivery pipeline (`ship_task` tool + `/ship` command)
 * - Repo-scoped persistent memory injection + `memory_save` / `memory_forget` tools
 * - Offline "dream" memory consolidation (`dream_consolidate` tool + `/dream` command)
 */
export function createAiShipPlugin(tool: ToolHelper) {
  const z = tool.schema;

  return async (ctx: { client: OpencodeClient; directory: string; worktree: string }) => {
    const repoRoot = ctx.worktree || ctx.directory;

    return {
      async config(cfg: Record<string, any>) {
        cfg.command = cfg.command ?? {};
        cfg.command.ship = {
          description: "Run the 4-stage ai-ship delivery pipeline in an isolated worktree",
          template:
            "Use the `ship_task` tool to implement, adversarially test, verify, and review this task:\n\n$ARGUMENTS",
        };
        cfg.command.dream = {
          description: "Consolidate repo memory from recent OpenCode session transcripts",
          template: "Use the `dream_consolidate` tool to consolidate memory for the current repository.",
        };
        cfg.command.remember = {
          description: "Save a note directly to persistent repository memory",
          template: "$ARGUMENTS",
        };
        cfg.command.cleanup = {
          description: "List or remove leftover ai-ship worktrees and ai/* branches",
          template:
            "Use `cleanup_worktrees` to inspect leftover ai-ship worktrees and branches (pass `confirm: true` only if the user asked to delete them): $ARGUMENTS",
        };
      },

      async "command.execute.before"(
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: Array<{ type: string; text?: string }> }
      ) {
        if (input.command !== "remember") return;
        const text = input.arguments.trim();
        const tui = (ctx.client as unknown as { tui?: { showToast?: (opts: any) => Promise<unknown> } }).tui;
        if (!text) {
          output.parts = [{ type: "text", text: "Ask the user what rule or fact they want to save to repo memory." }];
          return;
        }
        const res = appendMemory(repoRoot, text, "note");
        const msg = res.added ? `Saved to repo memory: ${text.slice(0, 60)}` : "Already in repo memory.";
        tui?.showToast?.({ body: { title: "ai-ship", message: msg, variant: "success" } }).catch(() => undefined);
        output.parts = [
          {
            type: "text",
            text: `Reply in one short sentence confirming this was saved to repo memory (do not call memory_save): "${text}"`,
          },
        ];
      },

      async "experimental.chat.system.transform"(_input: unknown, output: { system: string[] }) {
        const memory = readMemory(repoRoot);
        if (memory) {
          output.system.push(`## Persistent Repository Memory\n${memory}`);
        }
      },

      tool: {
        ship_task: tool({
          description:
            "Run the 4-stage ai-ship pipeline (isolated worktree -> implement -> adversarial tests -> local verify -> 3-lens review -> rebase & optional PR).",
          args: {
            task: z.string().describe("Task description to implement and verify"),
            openPr: z.boolean().optional().describe("Rebase, push branch, and open a PR after all stages pass"),
            skipTests: z.boolean().optional().describe("Skip Stage 2 independent adversarial test generation"),
            skipReview: z.boolean().optional().describe("Skip Stage 4 parallel multi-lens review"),
            model: z.string().optional().describe("Optional model override (provider/model)"),
          },
          async execute(args, toolCtx) {
            const targetRepo = toolCtx.worktree || toolCtx.directory || repoRoot;
            await runPipeline({
              repoDir: targetRepo,
              task: args.task,
              openPr: Boolean(args.openPr),
              skipTests: Boolean(args.skipTests),
              skipReview: Boolean(args.skipReview),
              model: args.model,
              client: ctx.client,
              onProgress: (stage) => notifyProgress(ctx.client, toolCtx, stage),
            });
            notifyProgress(ctx.client, toolCtx, `Completed: ${args.task.slice(0, 50)}`, "success");
            return `ai-ship pipeline completed for "${args.task}" in ${targetRepo}.`;
          },
        }),

        memory_save: tool({
          description:
            "Save a durable, repo-specific fact, invariant, or pitfall to persistent repository memory.",
          args: {
            entry: z.string().describe("Concise, reusable rule or fact to remember"),
            category: z
              .string()
              .optional()
              .describe("Short category tag such as architecture, security, testing, or build"),
          },
          async execute(args, toolCtx) {
            const targetRepo = toolCtx.worktree || toolCtx.directory || repoRoot;
            const res = appendMemory(targetRepo, args.entry, args.category || "note");
            return res.added
              ? `Saved to repo memory (${res.path}).`
              : `Already present or empty; skipped (${res.path}).`;
          },
        }),

        memory_forget: tool({
          description: "Remove outdated or incorrect entries matching a query from repository memory.",
          args: {
            query: z.string().describe("Case-insensitive substring matching the memory entry to remove"),
          },
          async execute(args, toolCtx) {
            const targetRepo = toolCtx.worktree || toolCtx.directory || repoRoot;
            const res = forgetMemory(targetRepo, args.query);
            return `Removed ${res.removedCount} matching entry(s) from ${res.path}.`;
          },
        }),

        dream_consolidate: tool({
          description:
            "Run offline dream consolidation: merge duplicates and prune stale repo memory against recent session transcripts.",
          args: {
            model: z.string().optional().describe("Optional model override for consolidation"),
          },
          async execute(args, toolCtx) {
            const targetRepo = toolCtx.worktree || toolCtx.directory || repoRoot;
            notifyProgress(ctx.client, toolCtx, "Dreaming: consolidating repo memory");
            const res = await runDreamConsolidation({
              repoDir: targetRepo,
              client: ctx.client,
              model: args.model,
            });
            notifyProgress(ctx.client, toolCtx, "Memory consolidated", "success");
            return `Consolidated memory at ${res.memoryPath} (${res.usageSummary}).`;
          },
        }),

        cleanup_worktrees: tool({
          description:
            "List or remove leftover ai-ship worktrees and ai/* branches. Defaults to dry-run unless confirm is true.",
          args: {
            confirm: z.boolean().optional().describe("Set true to delete listed worktrees and branches"),
          },
          async execute(args, toolCtx) {
            const targetRepo = toolCtx.worktree || toolCtx.directory || repoRoot;
            const targets = listCleanupTargets(targetRepo);
            const deletableBranches = targets.branches.filter((b) => !b.checkedOutInMain);
            if (targets.worktrees.length === 0 && deletableBranches.length === 0) {
              return "Nothing to clean up.";
            }
            const summary = [
              `Worktrees (${targets.worktrees.length}): ${targets.worktrees.map((w) => w.path).join(", ") || "(none)"}`,
              `Branches (${deletableBranches.length}): ${deletableBranches.map((b) => `${b.name}${b.merged ? " [merged]" : ""}`).join(", ") || "(none)"}`,
            ].join("\n");
            if (!args.confirm) {
              return `Dry run — pass confirm=true to remove:\n${summary}`;
            }
            const removed = removeCleanupTargets(targetRepo, targets);
            notifyProgress(
              ctx.client,
              toolCtx,
              `Cleaned ${removed.removedWorktrees.length} worktree(s), ${removed.removedBranches.length} branch(es)`,
              "success"
            );
            return `Removed ${removed.removedWorktrees.length} worktree(s) and ${removed.removedBranches.length} branch(es).`;
          },
        }),
      },
    };
  };
}
