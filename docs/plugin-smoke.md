# Native plugin smoke checklist (run after each OpenCode Desktop update)

Automated: `npm run test:contract` boots the real `opencode-cli` (2.x) with a fake model and checks the API ai-ship relies on (sessions, child `parentID`, prompt/wait/messages, a second prompt).

Manual, in OpenCode Desktop (and TUI/web if used), with the ai-ship MCP server removed (`ai-ship --doctor --fix`):

1. `ai-ship --plugin-install`, restart Desktop, run `/ship-doctor` → all ✔ (pricing/token warnings are expected until configured).
2. `/ship Add a one-line comment to README --skip-review` → returns a job id immediately; a `ship: …` session appears with an `Implement: …` child; tool calls stream live.
3. `/ship-status` → shows the job and recent per-agent lines; when done shows the summary (branch, verify, review).
4. `/ship <task> ` then `/ship-cancel` → agent sessions are interrupted; worktree kept.
5. `/remember <fact>`, `/forget <fact>` → confirmation text.
6. `/cleanup` (dry run) → lists leftovers; `/cleanup --yes` removes clean/merged ones only.
7. `/safety-check` → passes on a clean repo.
8. `/pr <title> --draft` on a finished worktree → opens a draft PR.
9. `/ship-init` in a fresh repo → creates AGENTS.md / .ai-ship.json (never overwrites).

Record OpenCode version and results in the PR that touches the plugin.
