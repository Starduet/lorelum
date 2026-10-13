import { digestJson } from "./digest";
import { ExperimentError } from "./experiment-error";
import { QUERY_ROLES, type QueryRole, type RoleSample } from "./role-sample";

/**
 * The single registered candidate policy for the role-aligned experiments.
 *
 * It is fixed before any new test result exists. Weights come from the
 * a-priori reading in the research plan (section 4.1), not from a search:
 * the current action decides applicability, a constraint changes
 * applicability and so is not background, and a domain noun must not decide
 * the task alone. No weight is tuned, and no Pack or Practice identity enters
 * the score.
 */
export const ROLE_POLICY_ID = "role-aligned-policy/1";

/** Integer tiers; only their ratios matter and they are renormalized over the roles present. */
export const ROLE_WEIGHTS: Readonly<Record<QueryRole, number>> = Object.freeze({
  intent: 3,
  constraints: 2,
  artifact: 2,
  moment: 1,
  domain: 1,
});

export const ROLE_POLICY = Object.freeze({
  id: ROLE_POLICY_ID,
  weights: ROLE_WEIGHTS,
  withinRole:
    "equal-weight mean of the per-text evidence over the role's distinct texts, across action groups",
  acrossRoles: "weighted mean over the roles present, with the weights renormalized to sum to 1",
  missingRole: "omitted; the remaining weights are renormalized, never filled with a default score",
  emptyChannel:
    "a Practice without task-card or body views contributes the component it has, exactly as the production clause score does",
  negativeCosine:
    "kept signed: no clamp, no floor and no extra penalty term; all weights are non-negative",
  duplicateEvidence:
    "identical query role text inside one role is encoded and counted once; the same text under two roles counts in each role; document views are never deduplicated",
  unknown: "never encoded and never scored; it only documents what the annotator could not assign",
  tieBreak:
    "descending score, then ascending Practice ID by UTF-16 code unit, as the production reader",
  fallback:
    "a query with no scorable role is scored by the production clause path and counted as a fallback; uncertainty never excludes a Practice",
  forbidden:
    "no lexical channel, no rank fusion, no candidate truncation, no Pack or Practice ID feature, no weight search",
});

export const ROLE_POLICY_DIGEST = digestJson(ROLE_POLICY);

export interface PlannedRole {
  readonly role: QueryRole;
  /** Normalized over the roles present. */
  readonly weight: number;
  /** Distinct texts to encode for this role, in canonical order. */
  readonly texts: readonly string[];
}

export type RoleQueryPlan =
  | { readonly status: "roles"; readonly roles: readonly PlannedRole[] }
  | { readonly status: "fallback"; readonly reason: "no-scorable-role" };

/** Turn a validated sample into the roles and texts that will be scored. */
export function planRoleQuery(sample: RoleSample): RoleQueryPlan {
  const present: { role: QueryRole; texts: string[] }[] = [];
  for (const role of QUERY_ROLES) {
    const texts: string[] = [];
    for (const annotation of sample.roles) {
      if (annotation.role === role && !texts.includes(annotation.text)) texts.push(annotation.text);
    }
    texts.sort(compareCodeUnits);
    if (texts.length > 0) present.push({ role, texts });
  }
  if (present.length === 0)
    return Object.freeze({ status: "fallback", reason: "no-scorable-role" });
  const total = present.reduce((sum, entry) => sum + ROLE_WEIGHTS[entry.role], 0);
  return Object.freeze({
    status: "roles",
    roles: Object.freeze(
      present.map((entry) =>
        Object.freeze({
          role: entry.role,
          weight: ROLE_WEIGHTS[entry.role] / total,
          texts: Object.freeze(entry.texts),
        }),
      ),
    ),
  });
}

/**
 * Fuse per-text evidence into one Practice score. `evidence[role]` holds one
 * value per planned text, in plan order. The function adds no term beyond the
 * registered policy.
 */
export function fuseRoleEvidence(
  plan: Extract<RoleQueryPlan, { status: "roles" }>,
  evidence: Readonly<Partial<Record<QueryRole, readonly number[]>>>,
): number {
  let score = 0;
  for (const planned of plan.roles) {
    const values = evidence[planned.role];
    if (values === undefined || values.length !== planned.texts.length) {
      throw new ExperimentError(
        "protocol_invalid",
        `Evidence for role ${planned.role} does not match its planned texts`,
      );
    }
    if (values.some((value) => !Number.isFinite(value))) {
      throw new ExperimentError("run_failed", `Evidence for role ${planned.role} is not finite`);
    }
    score += planned.weight * (values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return score;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ScoredPractice {
  readonly practiceId: string;
  readonly score: number;
}

/** The registered ranking order: higher score first, then Practice ID. */
export function compareScoredPractices(left: ScoredPractice, right: ScoredPractice): number {
  const scoreOrder = right.score - left.score;
  return scoreOrder === 0 ? compareCodeUnits(left.practiceId, right.practiceId) : scoreOrder;
}

export interface AttributionCondition {
  readonly id: "control" | "Q" | "Q+I" | "Q+I+D";
  readonly queryRepresentation: string;
  readonly documentRepresentation: string;
  readonly withinPracticeReduction: string;
  readonly fusion: string;
  /** What this condition changes relative to the previous one; empty for control. */
  readonly changes: readonly string[];
  readonly gate: string;
}

const PRODUCTION_REDUCTION =
  "per query text: 0.5 x best task-card cosine + 0.5 x (0.5 x best body cosine + 0.5 x mean body cosine)";

/** Conditions are run in this order; each differs from its predecessor in one declared way. */
export const ATTRIBUTION_CONDITIONS: readonly AttributionCondition[] = Object.freeze([
  {
    id: "control",
    queryRepresentation: "production clause split (query projection v2)",
    documentRepresentation: "production views: full / task-card / body (document projection v4)",
    withinPracticeReduction: PRODUCTION_REDUCTION,
    fusion: "equal-weight mean over clauses",
    changes: [],
    gate: "G0: every query x Practice production score recomputed within 1e-6 and frozen metrics reproduced",
  },
  {
    id: "Q",
    queryRepresentation: "manual source-backed role texts (role-sample format 1)",
    documentRepresentation: "unchanged",
    withinPracticeReduction: `${PRODUCTION_REDUCTION}, evaluated separately for each role text`,
    fusion: "ROLE_WEIGHTS mean over the roles present",
    changes: ["query representation", "cross-text fusion weights"],
    gate: "G1",
  },
  {
    id: "Q+I",
    queryRepresentation: "same role texts as Q",
    documentRepresentation: "unchanged",
    withinPracticeReduction:
      "joint unit: each task-card or body view is scored by the ROLE_WEIGHTS sum of its role cosines first, then reduced with the production max / mean rule, so one evidence unit must support the roles together",
    fusion: "ROLE_WEIGHTS applied inside the joint unit; no further fusion",
    changes: ["where the maximum over document views is taken"],
    gate: "G1",
  },
  {
    id: "Q+I+D",
    queryRepresentation: "same role texts as Q",
    documentRepresentation:
      "adds source-backed document role views, encoded as a separate intervention",
    withinPracticeReduction: "same as Q+I over the enlarged evidence set",
    fusion: "same as Q+I",
    changes: ["document representation"],
    gate: "G2, only if Q+I passes its gate",
  },
]);

/** Negative controls that keep extra tokens and restatement separate from role effects. */
export const NEGATIVE_CONTROLS: readonly string[] = Object.freeze([
  "append meaning-neutral background text to the query",
  "restate each role with equivalent wording and no new fact",
  "apply the same text-processing budget with non-role text",
]);
