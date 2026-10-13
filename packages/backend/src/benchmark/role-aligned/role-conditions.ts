import { type RoleQueryPlan } from "./candidate-policy";
import { dot, reduceViewCosines } from "./control-formula";
import { ExperimentError } from "./experiment-error";

/**
 * Scoring of the two G1 role conditions over one Practice. Both use exactly the
 * texts and the production within-Practice reduction; they differ only in
 * where the reduction's maximum is taken.
 *
 *   Q    each role text is reduced over the Practice's views on its own, then
 *        the per-text results are fused: mean over a role's texts, weighted
 *        mean over the roles present.
 *   Q+I  each task-card or body view first receives one joint cosine, the same
 *        fused sum of its per-text cosines, and the production reduction is
 *        applied once to those joint cosines. One evidence unit must therefore
 *        support the roles together.
 *
 * Cosine is linear in the fusion, so the two differ only through the maximum.
 * No lexical term, no clamp, no negative weight, no Practice or Pack identity.
 */
export interface ScoringView {
  readonly kind: "full" | "task-card" | "body";
  readonly vector: ArrayLike<number>;
}

/** Vectors keyed by the exact encoded text. */
export type TextVectors = ReadonlyMap<string, ArrayLike<number>>;

/** `registered` is the policy's role weights; `flat` is an attribution control, not a candidate. */
export type RoleWeighting = "registered" | "flat";

type RolesPlan = Extract<RoleQueryPlan, { status: "roles" }>;

export function roleWeightsOf(plan: RolesPlan, weighting: RoleWeighting): readonly number[] {
  return plan.roles.map((planned) =>
    weighting === "registered" ? planned.weight : 1 / plan.roles.length,
  );
}

function vectorOf(vectors: TextVectors, text: string): ArrayLike<number> {
  const vector = vectors.get(text);
  if (vector === undefined) {
    throw new ExperimentError("run_failed", "A planned role text has no vector");
  }
  return vector;
}

function cosinesBy(
  views: readonly ScoringView[],
  vector: ArrayLike<number>,
): { taskCards: number[]; bodies: number[] } {
  const taskCards: number[] = [];
  const bodies: number[] = [];
  for (const view of views) {
    if (view.kind === "task-card") taskCards.push(dot(vector, view.vector));
    else if (view.kind === "body") bodies.push(dot(vector, view.vector));
  }
  return { taskCards, bodies };
}

export function scoreSeparately(
  plan: RolesPlan,
  weights: readonly number[],
  vectors: TextVectors,
  views: readonly ScoringView[],
): number {
  let score = 0;
  plan.roles.forEach((planned, roleIndex) => {
    let sum = 0;
    for (const text of planned.texts) {
      const { taskCards, bodies } = cosinesBy(views, vectorOf(vectors, text));
      sum += reduceViewCosines(taskCards, bodies);
    }
    score += weights[roleIndex]! * (sum / planned.texts.length);
  });
  return score;
}

export function scoreJointly(
  plan: RolesPlan,
  weights: readonly number[],
  vectors: TextVectors,
  views: readonly ScoringView[],
): number {
  const taskCardCount = views.filter((view) => view.kind === "task-card").length;
  const bodyCount = views.length - taskCardCount - views.filter((v) => v.kind === "full").length;
  const taskCards: number[] = new Array<number>(taskCardCount).fill(0);
  const bodies: number[] = new Array<number>(bodyCount).fill(0);
  plan.roles.forEach((planned, roleIndex) => {
    const share = weights[roleIndex]! / planned.texts.length;
    for (const text of planned.texts) {
      const cosines = cosinesBy(views, vectorOf(vectors, text));
      cosines.taskCards.forEach((value, index) => (taskCards[index]! += share * value));
      cosines.bodies.forEach((value, index) => (bodies[index]! += share * value));
    }
  });
  return reduceViewCosines(taskCards, bodies);
}
