# ai-ship OpenCode plugin

## OpenCode 2.x (Desktop 2.3+) — native plugin

OpenCode 2.x loads plugins from `~/.config/opencode/plugins/` but requires a **default export `{ id, setup(ctx) }`**; the 1.x `Plugin` function format below is rejected by 2.x ("Plugin must export a default definition with an id and an effect or setup function").

Install (until `ai-ship plugin install` lands):

```sh
echo 'export { default } from "/Users/<you>/ai-ship/plugin/v2/index.ts";' > ~/.config/opencode/plugins/ai-ship.ts
```

Restart OpenCode Desktop. Commands:

| Command | What it does |
|---|---|
| `/ship <task or noty://item/…> [--pr] [--draft] [--skip-tests] [--skip-review] [--skip-bughunter] [--model p/m] [--tester-model p/m] [--reviewer-model p/m]` | Starts the pipeline in the background and returns immediately |
| `/ship-status [job]` | Job status and the latest per-agent progress lines |
| `/remember <fact>` · `/forget <text>` | Repo memory |
| `/cleanup [--yes] [--force]` | Leftover worktrees / `ai/*` branches (dry run without `--yes`) |
| `/safety-check` | Secret / deployment-ID scan |
| `/pr <title> [--draft]` | Rebase, push and open a PR for an ai-ship worktree |

**Live progress:** each run creates a `ship: <task>` session at the worktree, and every agent (Implement, Adversarial Tests, Review (Security|Performance|Correctness), Bughunter Hunter/Skeptic/Referee, test disputes) is a **child subagent session** of it, so Desktop shows each agent's tool calls, edits and reasoning live, and the ship session receives a `<subagent>` report after every round.

Reviewers are read-only even though 2.x prompts have no per-prompt tool switches: ai-ship checkpoints before each review round and reverts any file a reviewer wrote. Read-only roles use the built-in `plan` agent when the server has it (override per role with `"oc2Agents"` in `.ai-ship.json`).

From a terminal you can drive the same Desktop service: `ai-ship "<task>" --attach` (agents show up in Desktop; progress lines print in the terminal).

Known limits: model fallback on 429/5xx is not applied on the 2.x path yet; the start/finish note posted into the invoking session uses `session.synthetic` and may not be displayed by every client — `/ship-status` always works.

## OpenCode 1.x — legacy plugin

`plugin/index.ts` targets the 1.x plugin API (`@opencode-ai/plugin` 1.19.x) and does not load on OpenCode 2.x:

```ts
import { tool, type Plugin } from "@opencode-ai/plugin";
import { createAiShipPlugin } from "/Users/<you>/ai-ship/plugin/index.ts";
export const AiShipPlugin: Plugin = createAiShipPlugin(tool);
```
