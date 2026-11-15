import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Monthly budget governor and spend ledger.
 *
 * Every model call is appended to an append-only JSONL ledger (`~/.local/share/ai-ship/ledger.jsonl`, override
 * with AI_SHIP_LEDGER_FILE). The governor turns month-to-date spend into a state that later stages act on:
 *
 * - GREEN  normal routing
 * - AMBER  spending ahead of the pro-rata line or past `softPct`: the router (task 14) drops one tier
 * - RED    past 95% of the spendable budget: cheapest tier only, bughunter off
 * - STOP   spendable budget used (monthly − reserve): new tasks refused unless `--override-budget`
 */

export interface LedgerEntry {
  ts: string;
  taskId: string;
  repo: string;
  stage: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  costSource?: string;
  /** "subscription" for calls billed by a flat subscription (claude-code); "metered" otherwise. */
  billing?: "metered" | "subscription";
}

export interface BudgetConfig {
  monthlyGBP: number;
  /** Kept back for evals / emergencies; normal tasks stop once spend reaches monthly − reserve. */
  reserveGBP: number;
  perTaskMaxGBP: number;
  softPct: number;
  /** Count subscription-billed calls (claude-code) as spend (default false: they are not cash spend). */
  countSubscription: boolean;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  monthlyGBP: 90,
  reserveGBP: 8,
  perTaskMaxGBP: 3,
  softPct: 75,
  countSubscription: false,
};

export type BudgetState = "GREEN" | "AMBER" | "RED" | "STOP";

export function getLedgerPath(): string {
  if (process.env.AI_SHIP_LEDGER_FILE) return process.env.AI_SHIP_LEDGER_FILE;
  // Never let a test run write fake spend into the real ledger.
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `ai-ship-test-ledger-${process.pid}.jsonl`);
  return path.join(os.homedir(), ".local", "share", "ai-ship", "ledger.jsonl");
}

/** Appends one entry as a single line (O_APPEND writes of one short line do not interleave). */
export function appendLedger(entry: LedgerEntry, file = getLedgerPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Reads ledger entries, skipping corrupt lines. `since` filters by timestamp. */
export function readLedger(file = getLedgerPath(), since?: Date): LedgerEntry[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (typeof e.costUsd !== "number" || !Number.isFinite(e.costUsd) || e.costUsd < 0 || typeof e.ts !== "string") continue;
      const t = new Date(e.ts);
      if (Number.isNaN(t.getTime())) continue;
      if (since && t < since) continue;
      out.push(e);
    } catch {
      // corrupt line: skip
    }
  }
  return out;
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function daysInMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

export function normalizeBudget(raw: unknown): BudgetConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const monthlyGBP = pos(r.monthlyGBP, DEFAULT_BUDGET.monthlyGBP);
  const perTask = pos(r.perTaskMaxGBP, DEFAULT_BUDGET.perTaskMaxGBP);
  return {
    monthlyGBP,
    reserveGBP: Math.min(monthlyGBP, pos(r.reserveGBP, DEFAULT_BUDGET.reserveGBP)),
    // 0 would read as "no cap" downstream; require a positive cap.
    perTaskMaxGBP: perTask > 0 ? perTask : DEFAULT_BUDGET.perTaskMaxGBP,
    softPct: Math.min(100, pos(r.softPct, DEFAULT_BUDGET.softPct)),
    countSubscription: r.countSubscription === true,
  };
}

export interface BudgetStatus {
  state: BudgetState;
  monthSpendGBP: number;
  spendableGBP: number;
  remainingGBP: number;
  proRataGBP: number;
  /** Suggested cap for today: remaining / remaining days × 1.5 (never above remaining). */
  dailyCapGBP: number;
  todaySpendGBP: number;
  forecastGBP: number;
  /** Max spend for the next task: min(perTaskMax, remaining). */
  taskCapGBP: number;
  /** Month-to-date calls whose cost is unknown (counted as £0, so spend may be understated). */
  unknownCostCalls: number;
  reasons: string[];
}

export function computeBudgetStatus(opts: {
  entries: LedgerEntry[];
  budget: BudgetConfig;
  gbpPerUsd: number;
  now?: Date;
}): BudgetStatus {
  const now = opts.now ?? new Date();
  const start = monthStart(now);
  const dim = daysInMonth(now);
  const day = now.getUTCDate();
  const elapsedFraction = Math.min(1, (day - 1 + (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440) / dim);
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  let monthUsd = 0;
  let todayUsd = 0;
  let unknownCostCalls = 0;
  for (const e of opts.entries) {
    const t = new Date(e.ts);
    if (Number.isNaN(t.getTime()) || t < start || t > now) continue;
    if (e.billing === "subscription" && !opts.budget.countSubscription) continue;
    if (e.costSource === "unknown") unknownCostCalls++;
    monthUsd += e.costUsd;
    if (t >= todayStart) todayUsd += e.costUsd;
  }
  const monthSpendGBP = monthUsd * opts.gbpPerUsd;
  const todaySpendGBP = todayUsd * opts.gbpPerUsd;
  const spendableGBP = Math.max(0, opts.budget.monthlyGBP - opts.budget.reserveGBP);
  const remainingGBP = Math.max(0, spendableGBP - monthSpendGBP);
  const proRataGBP = spendableGBP * elapsedFraction;
  const remainingDays = Math.max(1, dim - day + 1);
  const dailyCapGBP = Math.min(remainingGBP, ((remainingGBP + todaySpendGBP) / remainingDays) * 1.5);
  const forecastGBP = elapsedFraction > 0 ? monthSpendGBP / elapsedFraction : monthSpendGBP;
  const reasons: string[] = [];
  let state: BudgetState = "GREEN";
  const pct = spendableGBP > 0 ? (monthSpendGBP / spendableGBP) * 100 : 100;
  if (monthSpendGBP >= spendableGBP) {
    state = "STOP";
    reasons.push(`spent £${monthSpendGBP.toFixed(2)} of £${spendableGBP.toFixed(2)} spendable this month`);
  } else if (pct >= 95) {
    state = "RED";
    reasons.push(`${pct.toFixed(0)}% of the spendable budget used`);
  } else if (
    pct >= opts.budget.softPct ||
    // Ahead of pace by more than one max-size task or 1.5 days of budget, so bursty use isn't AMBER all month.
    monthSpendGBP > proRataGBP + Math.max(opts.budget.perTaskMaxGBP, (1.5 * spendableGBP) / dim)
  ) {
    state = "AMBER";
    reasons.push(
      pct >= opts.budget.softPct
        ? `${pct.toFixed(0)}% of the spendable budget used (soft limit ${opts.budget.softPct}%)`
        : `spending ahead of pro-rata (£${monthSpendGBP.toFixed(2)} vs £${proRataGBP.toFixed(2)})`
    );
  }
  if (state !== "STOP" && todaySpendGBP >= dailyCapGBP && dailyCapGBP > 0) {
    reasons.push(`today's spend £${todaySpendGBP.toFixed(2)} reached the daily cap £${dailyCapGBP.toFixed(2)}`);
    if (state === "GREEN") state = "AMBER";
  }
  return {
    state,
    monthSpendGBP,
    spendableGBP,
    remainingGBP,
    proRataGBP,
    dailyCapGBP,
    todaySpendGBP,
    forecastGBP,
    taskCapGBP: Math.min(opts.budget.perTaskMaxGBP, remainingGBP),
    unknownCostCalls,
    reasons,
  };
}

/** Month-to-date breakdown by a key (model, stage, repo). */
export function breakdown(entries: LedgerEntry[], key: (e: LedgerEntry) => string, gbpPerUsd: number): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(key(e) || "(unknown)", (m.get(key(e) || "(unknown)") ?? 0) + e.costUsd * gbpPerUsd);
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function formatBudgetReport(
  status: BudgetStatus,
  allEntries: LedgerEntry[],
  gbpPerUsd: number,
  opts: { countSubscription?: boolean } = {}
): string[] {
  // Same filter as computeBudgetStatus, so breakdowns add up to month-to-date spend.
  const entries = allEntries.filter((e) => opts.countSubscription || e.billing !== "subscription");
  const lines = [
    `Budget: ${status.state}${status.reasons.length ? ` — ${status.reasons.join("; ")}` : ""}`,
    `Month to date: £${status.monthSpendGBP.toFixed(2)} of £${status.spendableGBP.toFixed(2)} spendable (pro-rata £${status.proRataGBP.toFixed(2)}, forecast £${status.forecastGBP.toFixed(2)})`,
    `Today: £${status.todaySpendGBP.toFixed(2)} (daily cap £${status.dailyCapGBP.toFixed(2)}); next task cap £${status.taskCapGBP.toFixed(2)}`,
  ];
  const unknown = entries.filter((e) => e.costSource === "unknown").length;
  if (unknown) lines.push(`Warning: ${unknown} call(s) had unknown cost (add prices to models.json).`);
  for (const [label, fn] of [
    ["By model", (e: LedgerEntry) => e.model ?? ""],
    ["By stage", (e: LedgerEntry) => e.stage],
    ["By repo", (e: LedgerEntry) => path.basename(e.repo)],
  ] as const) {
    const rows = breakdown(entries, fn, gbpPerUsd).slice(0, 8);
    if (rows.length) lines.push(`${label}:`, ...rows.map(([k, v]) => `  ${k}: £${v.toFixed(2)}`));
  }
  return lines;
}

/** Budget config: models.json `budget` overridden by the repo's `.ai-ship.json` `budget`. */
export function loadBudgetConfig(repoBudget: unknown, modelsFile: string): BudgetConfig {
  let fileBudget: unknown;
  try {
    fileBudget = (JSON.parse(fs.readFileSync(modelsFile, "utf8")) as { budget?: unknown }).budget;
  } catch {
    fileBudget = undefined;
  }
  const a = fileBudget && typeof fileBudget === "object" ? fileBudget : {};
  const b = repoBudget && typeof repoBudget === "object" ? repoBudget : {};
  return normalizeBudget({ ...a, ...b });
}

export class BudgetStopError extends Error {
  readonly status: BudgetStatus;
  constructor(status: BudgetStatus) {
    super(
      `Monthly budget exhausted (${status.reasons.join("; ")}). New tasks are refused; re-run with --override-budget to proceed anyway.`
    );
    this.name = "BudgetStopError";
    this.status = status;
  }
}
