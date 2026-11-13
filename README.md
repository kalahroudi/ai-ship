# ai-ship

Project-agnostic OpenCode delivery pipeline built for **high-security, high-performance engineering** without Claude Max lockouts, constant command approvals, or GitHub CI bottlenecks.

## What it does
For any git repository, `ai-ship` runs 4 automated stages in an isolated git worktree:
1. **Implement (`implementer` agent):** Writes the change in a fresh short session with safe local dev commands auto-approved.
2. **Independent Adversarial Tests (`tester` agent):** Spins up a **separate session on a different model** that sees only the task intent + diff and writes hostile security, edge-case, and performance tests.
3. **Deterministic Local Gate:** Runs your repo's `typecheck`, `lint`, `build`, `test`, and `semgrep` (if installed) locally—looping back to the implementer on failure before GitHub ever sees a commit.
4. **Shared-Context Multi-Lens Review (`reviewer` agent):** Writes `.ai-ship-shared-context.txt` once and runs **3 parallel read-only reviewers** (Security, Performance, Correctness) returning `VERDICT: CLEAN` or `VERDICT: OPEN`.

## Quickstart

1. Export your OpenRouter API key (add to `~/.zshrc`):
   ```sh
   export OPENROUTER_API_KEY="sk-or-..."
   ```
   *(Optional: route via Cloudflare AI Gateway by setting `provider.openrouter.options.baseURL` in `~/.config/opencode/opencode.json`.)*

2. Link `ai-ship` globally (optional, already installed in `~/ai-ship`):
   ```sh
   cd ~/ai-ship && npm link
   ```

3. Initialize any repository (e.g. `~/rose`) with a lean `AGENTS.md` map and `.ai-ship.json`:
   ```sh
   ai-ship --init --repo ~/rose
   ```

4. Ship a task:
   ```sh
   ai-ship "Add org invite endpoint with RBAC and rate limiting" --repo ~/rose
   # Add --pr to push & open a GitHub PR automatically after all 4 stages pass:
   ai-ship "Add org invite endpoint with RBAC and rate limiting" --repo ~/rose --pr
   ```

## Configuration
- Global models & zero-friction permissions: `~/.config/opencode/opencode.json`
- Per-repo verify commands & overrides: `<repo>/.ai-ship.json` (auto-detects `package.json`, `Package.swift`, `Cargo.toml`, `go.mod`, `pyproject.toml`, and `semgrep` when omitted).
