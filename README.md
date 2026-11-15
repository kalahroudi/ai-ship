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

## Requirements
- Node.js >= 22.18 (runs TypeScript directly).
- git >= 2.30 (`--force-with-lease --force-if-includes` is used when re-pushing a rebased `ai/*` branch), and `gh` for PRs.

## Verify-gate integrity
- npm/yarn worktrees get a private copy-on-write clone of `node_modules` (APFS `cp -c`, Linux `--reflink=always`); if cloning is unavailable they fall back to a symlink to the main repo's `node_modules`.
- Every `node_modules/.bin` tool (and the package behind it) is fingerprinted at run start and re-checked before each verify run. If an agent's `npm install` rewrites an existing tool package, the run stops; re-run once the dependency change is intended.
- Files that verify commands invoke (e.g. `scripts/test.sh` behind `npm test`) are protected for the run, alongside `.ai-ship.json`, package.json scripts, CI and test-runner config. Use `--allow-config-change` for intended changes.

## Git safety
- Re-pushing an existing `ai/*` branch uses `--force-with-lease --force-if-includes`, so a collaborator's commit is never overwritten. Other branches are never force-pushed.
- Re-running with an open PR updates its body; the title is left as is.
- `--cleanup` keeps dirty worktrees, orphan directories and unmerged branches (squash-merged branches count as unmerged) unless you pass `--force`.

## MCP (for clients other than OpenCode, e.g. Claude Code)
`ai-ship --mcp` serves `ship_task` (blocking), plus **`ship_start`** (runs in the background and returns a job id immediately), **`ship_status`** (stage, recent per-agent progress, final summary) and **`ship_cancel`** (stops at the next stage boundary, before any commit/PR). Long runs no longer hit MCP client timeouts. Jobs live in the MCP server process (not persisted across restarts). Inside OpenCode use the native plugin instead.

## Configuration
- Global models & zero-friction permissions: `~/.config/opencode/opencode.json`
- Per-repo verify commands & overrides: `<repo>/.ai-ship.json` (auto-detects `package.json`, `Package.swift`, `Cargo.toml`, `go.mod`, `pyproject.toml`, and `semgrep` when omitted).

### Independent Models per Role
The tester, reviewers and bughunter must run on models different from the implementer, otherwise "independent" tests and reviews would just be the implementer checking itself.
- `--model` overrides only the **implementer**. Use `--tester-model`, `--reviewer-model` and `--bughunter-model` for the others (also available as MCP args).
- `claude-code` runner defaults: implementer `opus`, tester `sonnet`, reviewer `haiku`, bughunter `sonnet`. Override with `"claudeModels": { "reviewer": "sonnet" }` in `.ai-ship.json`.
- At start (before any worktree or model call), ai-ship prints the role → model table and fails if any reviewing role — or its fallback model, or a `reviewerLensModels` entry — shares the implementer's model or the implementer's fallback. The same model name via a different provider prefix is a warning. Set `"strictIndependence": false` to downgrade failures to warnings.
- `reviewerLensModels` entries take precedence over `--reviewer-model` for their lens.

### Model catalog & Cloudflare AI Gateway
`~/.config/ai-ship/models.json` (template: [`templates/models.json`](./templates/models.json)) lists the models ai-ship may use, with tier (1 cheap → 3 frontier), family, context size, price and per-role strengths, plus your Cloudflare AI Gateway (`accountId`, `gatewayId`, token env var).

- With `"gateway": { …, "enabled": true }` every enabled model is exposed to OpenCode as `aig/<provider>/<model>`, routed through a local egress proxy to the gateway's `/compat` endpoint. The proxy adds `cf-aig-authorization: Bearer $CF_AIG_TOKEN` and `cf-aig-metadata` tags; provider keys stay in Cloudflare (BYOK).
- In direct (Desktop) mode the snippet uses a placeholder API key (`gateway`); with BYOK stored in Cloudflare the gateway authenticates the provider call itself — run `ai-ship --models-sync` once to confirm your gateway accepts it.
- `ai-ship --models` lists the catalog; `--models-sync` sends a 1-token request per model through the gateway; `--models-opencode-config` prints the provider entry to paste into `opencode.json` for OpenCode Desktop (OpenCode never discovers gateway models on its own).
- Catalog prices also feed cost accounting (also for the `aig/…` alias).

### Task classifier & model router (opt-in: `"router": true`)
Each task is classified with zero model calls — size S/M/L, risk low/med/high, kind and domains (auth, billing, migration, crypto, concurrency, ui, infra) from the task text, `--tag size:L` / `risk:high` overrides and `git grep` hits — and re-classified from the real diff after Stage 1.
The router then picks catalog models per role: implementer S→tier 1, M→2, L or high risk→3; tester tier 2; reviewers tier 1–2; the Security lens tier 3 on high-risk tasks; bughunter 2–3. Tester and reviewers always come from a **different model family** than the implementer, fallbacks prefer other providers, budget AMBER drops one tier (never the high-risk Security lens), RED uses tier 1, and after two failed fixes the implementer escalates one tier once. Explicit `--model` / role-model flags always win.
`ai-ship --route "<task>"` prints the plan without running anything.

### Throughput & learning
- **Per-model concurrency:** catalog `maxConcurrency` limits concurrent gateway requests per model in the egress proxy (FIFO queue), so parallel reviewers don't trigger 429 storms on one provider.
- **Parallel verify (opt-in):** `"verifyParallel": true` runs the verify commands concurrently (only for commands that don't share outputs); the first failing command in configured order is reported.
- **Outcome log & adaptive routing:** every task is recorded in `~/.local/share/ai-ship/outcomes.jsonl` (result, size/risk, role models, fix and review rounds, open findings, cost). The router adds a small learned bonus (±0.1, after ≥3 observations, 30-day half-life) per role and model based on first-pass success, so cheaper models that keep succeeding win ties.
- `ai-ship --report` shows spend vs budget, tasks, first-pass success, cost per committed task and quality per model.

### Monthly budget governor (£)
Every model call is appended to `~/.local/share/ai-ship/ledger.jsonl`. Before each task ai-ship computes month-to-date spend (converted with `fx.GBPUSD` from models.json) against `budget` (models.json, overridable per repo): defaults `monthlyGBP: 90`, `reserveGBP: 8` (kept for evals), `perTaskMaxGBP: 3`, `softPct: 75`.
- **GREEN** normal · **AMBER** spending ahead of pro-rata, past the soft %, or today's cap reached (router downgrades a tier, task 14) · **RED** ≥ 95% of spendable: bughunter skipped · **STOP** spendable used: new tasks refused (`--override-budget` to force).
- Each task's cost cap is the lower of `maxTaskCostUsd` and min(`perTaskMaxGBP`, remaining). Tasks started in parallel each get the full cap; the reserve absorbs the overlap.
- claude-code calls are recorded as subscription-billed (not counted as cash spend) unless `ANTHROPIC_API_KEY` is set (then metered) or `"countSubscription": true`.
- `ai-ship --budget` shows month-to-date, pro-rata, forecast, today's cap, and spend by model, stage and repo.

### Budget Circuit Breaker
`ai-ship` tracks `input`, `output`, `cache_read` tokens and USD cost across all stages and retries, and aborts cleanly before launching the next stage/retry if thresholds are reached. Defaults are `maxTaskCostUsd: 5` and `maxTaskTokens: 2000000` (set to `null` or `0` to disable).

**Cost accuracy:** OpenCode reports `$0` for models it has no price for (custom openai-compatible providers, Cloudflare AI Gateway `/compat` models), which would make `maxTaskCostUsd` blind. ai-ship therefore computes cost from token usage (input, output + reasoning, cache read/write) using a pricing table:
- `~/.config/ai-ship/models.json` → `"pricing": { "provider/model": { "in": <USD/Mtok>, "out": <USD/Mtok>, "cacheRead": …, "cacheWrite": …, "checked": "YYYY-MM-DD" } }` (template: [`templates/models.json`](./templates/models.json)), overridable per repo with `"pricing"` in `.ai-ship.json`. Keys match exactly, case-insensitively, or as a suffix (`cloudflare-ai-gateway/deepseek/deepseek-chat` uses a `deepseek/deepseek-chat` entry).
- At start ai-ship warns about role models without a price (including models OpenCode prices itself, such as the defaults — add them to silence the warning; use `{ "in": 0, "out": 0 }` for free/local models). `"requirePricing": true` turns that into an error before any model call (also for roles left to the OpenCode agent default) and aborts on any call whose cost is still unknown. Otherwise unknown-cost calls are flagged in the stage summary.
- Usage is summed over every step of an agent turn (OpenCode returns only the last step's tokens).
- Tokens spent on retried attempts (e.g. empty reviewer replies) are counted too.

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

Context Lens forwards to a single upstream, so ai-ship routes only one provider through it: `"contextLensProvider"` in `.ai-ship.json`, or the implementer's provider by default. Other providers keep their direct or Cloudflare AI Gateway URLs, and the run log says which ones were not proxied.

When attached to an existing server (`--server`, or the plugin/MCP client), ai-ship cannot change that server's provider or agent config. It logs which settings are ignored (gateway URL, Context Lens, `.ai-ship.json` providers) and warns if the server's `reviewer`/`bughunter` agents do not deny edit and bash. Per-prompt tool restrictions still apply.

Every run also logs per-stage and task-total token/cache telemetry (`in`, `out`, `cache_read`, `cache_hit` ratio, and USD cost) in `usageLog` and `formatPipelineResult()`:
```text
[ai-ship] Per-Stage & Task Totals:
  [Stage Totals]
    Stage 1: Implement: in=1200 out=350 cache_read=4800 cache_hit=80.0% total=6350 | $0.0142 (1 call)
    Stage 4: Review: in=900 out=240 cache_read=2700 cache_hit=75.0% total=3840 | $0.0095 (3 calls)
  [Task Total] in=2100 out=590 cache_read=7500 total=10190 | $0.0237 (cache_hit=78.1%)
```

### Model evals (vet a model before routing to it)
`ai-ship --eval implementer --model <provider/model>` runs the implementer on the fixture tasks in `evals/implementer/` (bug fix, feature, security, async concurrency) and scores them with hidden acceptance tests copied in only after the agent finishes. `ai-ship --eval reviewer --model <provider/model>` scores verdicts on `evals/reviewer/` diffs with planted bugs and clean diffs (accuracy, OPEN recall/precision). Options: `--eval-n <1-10>` repeats, `--eval-only a,b`, `--eval-max-cost <usd>`. Spend goes to the budget ledger and the run is refused when the budget is STOP. Reports are saved in `~/.local/share/ai-ship/evals/`; `ai-ship --eval-results` lists the latest per model. Enable a new model in `models.json` only after it passes.
