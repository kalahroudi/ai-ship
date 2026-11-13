# ai-ship

Project-agnostic OpenCode delivery pipeline built for high-security, high-performance engineering without bottlenecks.

## What it does
For any git repository, `ai-ship` runs 4 automated stages in an isolated git worktree:
1. **Implement (`implementer` agent):** Writes the change in a fresh short session with safe local dev commands auto-approved.
2. **Independent Adversarial Tests (`tester` agent):** Spins up a **separate session on a different model** that sees only the task intent + diff and writes hostile security, edge-case, and performance tests.
3. **Deterministic Local Gate:** Runs your repo's `typecheck`, `lint`, `build`, `test`, and `semgrep` (if installed) locally—looping back to the implementer on failure before a commit is pushed.
4. **Shared-Context Multi-Lens Review (`reviewer` agent):** Writes `.ai-ship-shared-context.txt` once and runs **3 parallel read-only reviewers** (Security, Performance, Correctness) returning `VERDICT: CLEAN` or `VERDICT: OPEN`.

## Quickstart

1. Link `ai-ship` globally (optional, already installed in `~/ai-ship`):
   ```sh
   cd ~/ai-ship && npm link
   ```

2. Initialize any repository (e.g. `~/rose`) with a lean `AGENTS.md` map and `.ai-ship.json`:
   ```sh
   ai-ship --init --repo ~/rose
   ```

3. Ship a task:
   ```sh
   ai-ship "Add org invite endpoint with RBAC and rate limiting" --repo ~/rose
   # Add --pr to push & open a PR automatically after all 4 stages pass:
   ai-ship "Add org invite endpoint with RBAC and rate limiting" --repo ~/rose --pr
   ```

## CLI Cheatsheet

| Command | Example |
|---|---|
| Ship a task | `ai-ship "Fix H1 gateway host escape" --repo ~/rose` |
| Ship + rebase + open PR | `ai-ship "Fix H1 gateway host escape" --repo ~/rose --pr` |
| Ship a Noty item | `ai-ship "noty://item/D282FF5A-FCE0-4034-8DFF-5694B8A29F99" --repo ~/rose --pr` |
| Attach to `opencode serve` (mobile/web) | `ai-ship "Fix bug" --repo ~/rose --server http://127.0.0.1:4096 --pr` |
| Skip Stage 2 tests or Stage 4 review | `ai-ship "Docs update" --repo ~/rose --skip-tests --skip-review` |
| Consolidate repo memory (dream) | `ai-ship --dream --repo ~/rose` |
| Initialize repo config | `ai-ship --init --repo ~/rose` |
| Clean up worktrees & `ai/*` branches | `ai-ship --cleanup --repo ~/rose` (add `--yes` to skip prompt) |

For OpenCode Desktop/TUI/Mobile plugin usage, see [plugin/README.md](./plugin/README.md).

## Configuration
- Global models & zero-friction permissions: `~/.config/opencode/opencode.json`
- Per-repo verify commands & overrides: `<repo>/.ai-ship.json` (auto-detects `package.json`, `Package.swift`, `Cargo.toml`, `go.mod`, `pyproject.toml`, and `semgrep` when omitted).
