# ai-ship OpenCode Plugin

`ai-ship` can be used as an OpenCode plugin (with TUI + `opencode serve` mobile support) while keeping the standalone `ai-ship` CLI intact.

## Setup

Add `~/.config/opencode/plugins/ai-ship.ts`:

```ts
import { tool, type Plugin } from "@opencode-ai/plugin";
import { createAiShipPlugin } from "/Users/mohammadramezanian/ai-ship/plugin/index.ts";

export const AiShipPlugin: Plugin = createAiShipPlugin(tool);
```

## Features
- `/ship` (`ship_task` tool): Runs the 4-stage worktree pipeline using OpenCode's live client with stage progress updates.
- `/remember <text>`: Immediately saves a highlighted/copied note to repo memory (`~/.local/share/opencode/memory/`) across Desktop, Web, Mobile, and TUI.
- `/dream` (`dream_consolidate` tool): Consolidates repo-scoped memory against recent session transcripts.
- `memory_save` / `memory_forget` tools + automatic system prompt injection.
