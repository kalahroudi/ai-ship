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
- `/cleanup` (`cleanup_worktrees` tool): Lists or removes leftover `.ai-ship-worktrees/*` and `ai/*` branches.
- `memory_save` / `memory_forget` tools + automatic system prompt injection.

## Command Cheatsheet (Desktop, Web, Mobile & TUI)

*(Restart OpenCode Desktop/TUI after installing the plugin so the commands appear.)*

| Command | Example |
|---|---|
| `/ship <task>` | `/ship Add rate limiting to /api/login --pr` |
| `/ship noty://item/<id> --pr` | `/ship noty://item/D282FF5A-FCE0-4034-8DFF-5694B8A29F99 --pr` |
| `/remember <note>` | `/remember Always pin target.pathname in gateway.ts` |
| `/dream` | `/dream` |
| `/cleanup` | `/cleanup` (lists worktrees/branches; ask to confirm deletion to remove them) |

### Natural-language tool examples
- **Save memory:** `Remember in repo memory (security): always pin target.pathname in gateway.ts.`
- **Forget memory:** `Forget the repo memory note about gateway.ts.`
- **Ship with options:** `Use ship_task to implement "Fix H1" with openPr=true.`
