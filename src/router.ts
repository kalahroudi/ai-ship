import type { BudgetState } from "./budget.ts";
import { GATEWAY_PROVIDER_ID, type Catalog, type CatalogModel, type RoleStrength, type Tier } from "./catalog.ts";
import type { Classification } from "./classify.ts";

/**
 * Policy-based model router. Picks a catalog model per role from the task classification, the budget
 * state and (later) learned scores, while keeping the tester and reviewers on a different model FAMILY than
 * the implementer. CLI pins (--model / --tester-model / …) always win and routed models replace the
 * `.ai-ship.json` role models; configured fallbacks and lens models are kept. The router is opt-in via
 * `"router": true` in .ai-ship.json or `router.enabled` in models.json.
 */

export type RoutedRole = "implementer" | "tester" | "reviewer" | "security" | "bughunter";

export interface RouteDecision {
  role: RoutedRole;
  /** OpenCode model ref: `aig/<provider>/<model>` when routed through the gateway, else `<provider>/<model>`. */
  model: string;
  catalogId: string;
  tier: Tier;
  fallbacks: string[];
  reason: string;
}

export interface RoutePlan {
  decisions: Partial<Record<RoutedRole, RouteDecision>>;
  notes: string[];
}

const STRENGTH_FOR: Record<RoutedRole, RoleStrength> = {
  implementer: "implement",
  tester: "test",
  reviewer: "review",
  security: "review",
  bughunter: "reason",
};

/** Default policy: base tier per role from size/risk. */
export function baseTier(role: RoutedRole, c: Classification): Tier {
  const big = c.size === "L" || c.risk === "high";
  switch (role) {
    case "implementer":
      return big ? 3 : c.size === "M" ? 2 : 1;
    case "tester":
      return 2;
    case "reviewer":
      return c.size === "S" && c.risk === "low" ? 1 : 2;
    case "security":
      return c.risk === "high" ? 3 : 2;
    case "bughunter":
      return big ? 3 : 2;
  }
}

/** Applies budget pressure and escalation to a base tier. Security on high-risk tasks is never downgraded by AMBER. */
export function adjustTier(tier: Tier, opts: { role: RoutedRole; risk: Classification["risk"]; budget: BudgetState; escalate?: boolean }): Tier {
  let t = tier;
  if (opts.escalate && opts.role === "implementer") t = Math.min(3, t + 1) as Tier;
  if (opts.budget === "RED" || opts.budget === "STOP") return 1;
  if (opts.budget === "AMBER" && !(opts.role === "security" && opts.risk === "high")) t = Math.max(1, t - 1) as Tier;
  return t;
}

function price(m: CatalogModel): number {
  return m.pricing ? m.pricing.in + m.pricing.out : Number.POSITIVE_INFINITY;
}

/** Score within a tier: role strength minus a small price penalty (unknown price ranks last). */
export function scoreModel(m: CatalogModel, role: RoutedRole, lambda = 0.01): number {
  const strength = m.strengths?.[STRENGTH_FOR[role]] ?? 0.5;
  const p = price(m);
  return strength - (Number.isFinite(p) ? lambda * p : 1);
}

/**
 * Candidates for a role at a tier: enabled, tool-calling, not excluded families; nearest tier if none at the
 * exact tier (prefer lower tiers when downgraded by budget, higher when escalated).
 */
export function candidates(catalog: Catalog, tier: Tier, opts: { excludeFamilies?: Set<string>; preferLower?: boolean }): CatalogModel[] {
  const usable = catalog.models.filter((m) => m.enabled && m.toolCalling !== false && !opts.excludeFamilies?.has(m.family ?? ""));
  const order: Tier[] = opts.preferLower
    ? ([tier, tier - 1, tier - 2, tier + 1, tier + 2].filter((t) => t >= 1 && t <= 3) as Tier[])
    : ([tier, tier + 1, tier - 1, tier + 2, tier - 2].filter((t) => t >= 1 && t <= 3) as Tier[]);
  for (const t of order) {
    const at = usable.filter((m) => m.tier === t);
    if (at.length) return at;
  }
  return [];
}

export function routeModels(opts: {
  catalog: Catalog;
  classification: Classification;
  budget: BudgetState;
  /** Escalate the implementer one tier (after repeated verify failures). */
  escalate?: boolean;
  viaGateway?: boolean;
  /** Learned per-model adjustments (task 16), added to the score. */
  bonus?: (modelId: string, role: RoutedRole) => number;
  /** Families the implementer must avoid (e.g. the reviewing roles' families when escalating mid-run). */
  implementerExcludeFamilies?: Set<string>;
  /** Pinned implementer model (`--model`): not routed, but reviewing roles must avoid its family. */
  pinnedImplementer?: string;
}): RoutePlan {
  const notes: string[] = [];
  const decisions: RoutePlan["decisions"] = {};
  const ref = (id: string) => (opts.viaGateway ? `${GATEWAY_PROVIDER_ID}/${id}` : id);
  const pick = (role: RoutedRole, excludeFamilies: Set<string>): RouteDecision | undefined => {
    const base = baseTier(role, opts.classification);
    const tier = adjustTier(base, { role, risk: opts.classification.risk, budget: opts.budget, escalate: opts.escalate });
    const list = candidates(opts.catalog, tier, { excludeFamilies, preferLower: tier < base });
    if (list.length === 0) {
      notes.push(`no catalog model for ${role} (tier ${tier}${excludeFamilies.size ? `, excluding ${[...excludeFamilies].join("/")}` : ""})`);
      return undefined;
    }
    const ranked = [...list].sort(
      (a, b) => scoreModel(b, role) + (opts.bonus?.(b.id, role) ?? 0) - (scoreModel(a, role) + (opts.bonus?.(a.id, role) ?? 0)) || a.id.localeCompare(b.id)
    );
    const best = ranked[0];
    // Fallbacks on other providers first, so one provider's outage does not take the role down.
    const provider = (id: string) => id.split("/")[0];
    // All filters (enabled, tool calling, family) run before trimming to two.
    const others = opts.catalog.models
      .filter((m) => m.enabled && m.toolCalling !== false && m.id !== best.id && !excludeFamilies.has(m.family ?? ""))
      .sort((a, b) => Number(provider(a.id) === provider(best.id)) - Number(provider(b.id) === provider(best.id)) || Math.abs(a.tier - tier) - Math.abs(b.tier - tier) || scoreModel(b, role) - scoreModel(a, role));
    return {
      role,
      model: ref(best.id),
      catalogId: best.id,
      tier: best.tier,
      fallbacks: others.map((m) => ref(m.id)),
      reason: `tier ${base}${tier !== base ? `→${tier}` : ""} (${opts.classification.size}/${opts.classification.risk}, budget ${opts.budget}${opts.escalate && role === "implementer" ? ", escalated" : ""}); ${best.id}${best.tier !== tier ? ` (nearest available: tier ${best.tier})` : ""} score ${scoreModel(best, role).toFixed(2)}`,
    };
  };

  const familyOf = (catalogId: string) => opts.catalog.models.find((m) => m.id === catalogId)?.family ?? "";
  const byRef = (r: string) => opts.catalog.models.find((m) => ref(m.id) === r || m.id === r);
  const pinnedFamily = (() => {
    if (!opts.pinnedImplementer) return undefined;
    const stripped = opts.pinnedImplementer.replace(new RegExp(`^${GATEWAY_PROVIDER_ID}/`), "");
    return byRef(opts.pinnedImplementer)?.family ?? byRef(stripped)?.family ?? stripped.split("/")[0];
  })();
  const impl = opts.pinnedImplementer ? undefined : pick("implementer", opts.implementerExcludeFamilies ?? new Set());
  if (impl) decisions.implementer = impl;
  const implFamily = new Set(impl ? [familyOf(impl.catalogId)] : pinnedFamily ? [pinnedFamily] : []);
  const reviewing = ["tester", "reviewer", "security", "bughunter"] as const;
  for (const role of reviewing) {
    const d = pick(role, implFamily);
    if (d) decisions[role] = d;
  }

  // Independence also covers failover: the implementer's fallbacks must not be any reviewing role's family, and
  // reviewing roles' fallbacks must not be the implementer's (primary or fallback) family.
  if (impl) {
    const reviewingFamilies = new Set(
      reviewing.flatMap((r) => (decisions[r] ? [familyOf(decisions[r]!.catalogId)] : []))
    );
    impl.fallbacks = impl.fallbacks.filter((f) => !reviewingFamilies.has(byRef(f)?.family ?? ""));
    const implFamilies = new Set([familyOf(impl.catalogId), ...impl.fallbacks.map((f) => byRef(f)?.family ?? "")]);
    for (const r of reviewing) {
      const d = decisions[r];
      if (d) d.fallbacks = d.fallbacks.filter((f) => !implFamilies.has(byRef(f)?.family ?? ""));
    }
  }
  for (const d of Object.values(decisions)) d.fallbacks = d.fallbacks.slice(0, 2);
  return { decisions, notes };
}

export function formatRoutePlan(plan: RoutePlan): string[] {
  const lines = Object.values(plan.decisions).map(
    (d) => `  ${d.role.padEnd(11)} ${d.model}  [${d.reason}]${d.fallbacks.length ? ` fallbacks: ${d.fallbacks.join(", ")}` : ""}`
  );
  return [...lines, ...plan.notes.map((n) => `  note: ${n}`)];
}
