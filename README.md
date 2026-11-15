# ai-ship

Project-agnostic OpenCode delivery pipeline built for high-security, high-performance engineering without bottlenecks.

## What it does
For any git repository, `ai-ship` runs 4 automated stages in an isolated git worktree:
1. **Implement (`implementer` agent):** Writes the change in a fresh short session with safe local dev commands auto-approved.
2. **Independent Adversarial Tests (`tester` agent):** Spins up a **separate session on a different model** that sees only the task intent + diff and writes hostile security, edge-case, and performance tests.
3. **Deterministic Local Gate:** Runs your repo's `typecheck`, `lint`, `build`, `test`, and `semgrep` (if installed) locally—looping back to the implementer on failure before a commit is pushed.
4. **Shared-Context Multi-Lens Review (`reviewer` agent):** Writes `.ai-ship/shared-context.txt` (git-excluded, removed after the round) once and runs **3 parallel read-only reviewers** (Security, Performance, Correctness) returning `VERDICT: CLEAN` or `VERDICT: OPEN`.
   - **Stage 4b — Adversarial Bughunter (`bughunter` agent):** Runs a read-only `Hunter -> Skeptic -> Referee` pass to hypothesize cross-boundary bugs, challenge false positives, and emit structured confirmed findings before committing.

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
| Route OpenCode through Context Lens proxy | `ai-ship "Fix bug" --repo ~/rose --context-lens` |
| Skip Stage 2 tests or Stage 4 review | `ai-ship "Docs update" --repo ~/rose --skip-tests --skip-review` |
| Consolidate repo memory (dream) | `ai-ship --dream --repo ~/rose` |
| Initialize repo config | `ai-ship --init --repo ~/rose` |
| Clean up worktrees & `ai/*` branches | `ai-ship --cleanup --repo ~/rose` (add `--yes` to skip prompt) |

For OpenCode Desktop/TUI/Mobile plugin usage, see [plugin/README.md](./plugin/README.md).

## Configuration
- Global models & zero-friction permissions: `~/.config/opencode/opencode.json`
- Per-repo verify commands & overrides: `<repo>/.ai-ship.json` (auto-detects `package.json`, `Package.swift`, `Cargo.toml`, `go.mod`, `pyproject.toml`, and `semgrep` when omitted).

### Budget Circuit Breaker
`ai-ship` tracks `input`, `output`, `cache_read` tokens and USD cost across all stages and retries, and aborts cleanly before launching the next stage/retry if thresholds are reached. Defaults are `maxTaskCostUsd: 5` and `maxTaskTokens: 2000000` (set to `null` or `0` to disable).

Example `.ai-ship.json`:
```json
{
  "maxFixRetries": 3,
  "maxReviewRounds": 2,
  "maxTaskCostUsd": 2.5,
  "maxTaskTokens": 500000
}
```

### Adversarial Bughunter (`Hunter -> Skeptic -> Referee`)
`ai-ship` includes a dedicated 4th `bughunter` role (read-only in both OpenCode and `claude-code`) that runs after the 3-lens review as Stage 4b:
1. **Hunter:** Hypothesizes cross-boundary bugs (caller/callee mismatches, shared state, auth/validation gaps) across files.
2. **Skeptic:** Challenges each hypothesis against the actual code and diff to filter out false positives.
3. **Referee:** Weighs both sides and emits structured `FINDING BUG-N | CONFIRMED | ...` lines and `VERDICT: CLEAN` or `VERDICT: OPEN`.

Configure `bughunter` and `bughunterModel` in `.ai-ship.json` (or pass `--skip-bughunter` on the CLI to skip Stage 4b):
```json
{
  "bughunter": true,
  "bughunterModel": { "providerID": "deepseek", "id": "deepseek-reasoner" },
  "bughunterFallbackModel": { "providerID": "parasail", "id": "Qwen/Qwen2.5-Coder-32B-Instruct" }
}
```

### Prompt Caching & Context Limits
To reduce token burn and preserve provider KV cache hits across both CLI (`runPipeline`) and plugin runs:
- Prompts place byte-identical static instructions first (including diff/patch-only edit guidance for `implementer`) and append dynamic task descriptions, repo memory (`readMemory(repoDir)`), and diffs at the end.
- Per-stage truncation limits are configurable via `contextLimits` in `.ai-ship.json` (defaults: `testDiffMaxChars: 40000`, `reviewDiffMaxChars: 60000`, `verifyOutputMaxChars: 6000`, `memoryMaxLines: 120`).

Example `.ai-ship.json` with `contextLimits`:
```json
{
  "contextLimits": {
    "testDiffMaxChars": 25000,
    "reviewDiffMaxChars": 45000,
    "verifyOutputMaxChars": 4000,
    "memoryMaxLines": 80
  }
}
```

### Context Lens Observability & Per-Stage Token Telemetry
Route OpenCode provider requests through a local [Context Lens](http://localhost:4040) proxy to inspect prompts, context growth, and KV cache behavior in real time.

Enable it via any of:
- **CLI flag:** `--context-lens` (defaults to `http://localhost:4040`) or `--context-lens=http://localhost:4040` / `--context-lens http://localhost:4040`
- **Environment variable:** `CONTEXT_LENS_URL=http://localhost:4040`
- **Repo config (`.ai-ship.json`):** `"contextLens": true` or `"contextLens": "http://localhost:4040"`

Example:
```sh
# Start Context Lens on http://localhost:4040, then run ai-ship:
CONTEXT_LENS_URL=http://localhost:4040 ai-ship "Add rate limiter" --repo ~/rose
# Or pass the CLI flag directly:
ai-ship "Add rate limiter" --repo ~/rose --context-lens
```

Every run also logs per-stage and task-total token/cache telemetry (`in`, `out`, `cache_read`, `cache_hit` ratio, and USD cost) in `usageLog` and `formatPipelineResult()`:
```text
[ai-ship] Per-Stage & Task Totals:
  [Stage Totals]
    Stage 1: Implement: in=1200 out=350 cache_read=4800 cache_hit=80.0% total=6350 | $0.0142 (1 call)
    Stage 4: Review: in=900 out=240 cache_read=2700 cache_hit=75.0% total=3840 | $0.0095 (3 calls)
  [Task Total] in=2100 out=590 cache_read=7500 total=10190 | $0.0237 (cache_hit=78.1%)
```
