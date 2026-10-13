import { ExperimentError } from "./experiment-error";

/**
 * Independent restatement of the frozen production scoring formula
 * (`scoreSemanticPractice`). It is deliberately written from the formula in
 * the change's verification record, not from the production code, so that an
 * agreement between the two means the control reproduces the pinned behavior
 * and not that one function was copied into the other.
 *
 *   clause score = 0.5 x best task-card cosine
 *                + 0.5 x (0.5 x best body cosine + 0.5 x mean body cosine)
 *   Practice score = weighted mean of the clause scores
 *
 * `full` views are context anchors and never enter the score.
 */
const TASK_CARD_SHARE = 0.5;
const BODY_BEST_SHARE = 0.5;

export interface FormulaVector {
  readonly viewId: string;
  readonly vector: ArrayLike<number>;
}

export interface FormulaClause extends FormulaVector {
  readonly weight: number;
}

export interface FormulaView extends FormulaVector {
  readonly kind: "full" | "task-card" | "body";
}

export function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) {
    throw new ExperimentError(
      "run_failed",
      "Vector dimensions differ in the control recomputation",
    );
  }
  let sum = 0;
  for (let index = 0; index < left.length; index += 1)
    sum += Number(left[index]) * Number(right[index]);
  return sum;
}

/**
 * The within-Practice reduction for one query text: best task-card cosine and
 * the best/mean body cosines share the score equally. A missing channel
 * leaves the other alone. Every role condition reuses this exact rule.
 */
export function reduceViewCosines(
  taskCardCosines: readonly number[],
  bodyCosines: readonly number[],
): number {
  if (taskCardCosines.length === 0 && bodyCosines.length === 0) {
    throw new ExperimentError("run_failed", "A Practice has no task-card or body view to score");
  }
  const parts: number[] = [];
  if (taskCardCosines.length > 0) parts.push(Math.max(...taskCardCosines));
  if (bodyCosines.length > 0) {
    const mean = bodyCosines.reduce((sum, value) => sum + value, 0) / bodyCosines.length;
    parts.push(BODY_BEST_SHARE * Math.max(...bodyCosines) + (1 - BODY_BEST_SHARE) * mean);
  }
  return parts.length === 2
    ? TASK_CARD_SHARE * parts[0]! + (1 - TASK_CARD_SHARE) * parts[1]!
    : parts[0]!;
}

export function recomputeControlScore(
  clauses: readonly FormulaClause[],
  views: readonly FormulaView[],
): number {
  const taskCards = views.filter((view) => view.kind === "task-card");
  const bodies = views.filter((view) => view.kind === "body");
  let weighted = 0;
  let totalWeight = 0;
  for (const clause of clauses) {
    const clauseScore = reduceViewCosines(
      taskCards.map((view) => dot(clause.vector, view.vector)),
      bodies.map((view) => dot(clause.vector, view.vector)),
    );
    weighted += clause.weight * clauseScore;
    totalWeight += clause.weight;
  }
  if (!(totalWeight > 0)) {
    throw new ExperimentError("run_failed", "Query clause weights have no positive mass");
  }
  return weighted / totalWeight;
}
