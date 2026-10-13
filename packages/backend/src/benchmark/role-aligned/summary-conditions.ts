import { dot } from "./control-formula";
import { ExperimentError } from "./experiment-error";
import type { ScoringView } from "./role-conditions";

/**
 * Three-channel clause score used by the summary-view experiment. For one
 * query clause, with T the best task-card cosine, B the body channel (half the
 * best, half the mean body cosine, as in production) and X the third channel,
 * the clause score is the equal-share mean of the channels that exist:
 *
 *   summary    X = best summary-view cosine
 *   duplicate  X = T (the weight shift of `summary` with no new information)
 *   full       X = best `full` view cosine
 *
 * The Practice score is the weighted mean of the clause scores with the
 * production clause weights. Weights are non-negative and fixed; nothing here
 * adds a lexical term, clamps a cosine or uses a Practice identity.
 */
export type ThirdChannel = "summary" | "duplicate" | "full";

export interface ClauseVector {
  readonly vector: ArrayLike<number>;
  readonly weight: number;
}

function best(values: readonly number[]): number {
  return Math.max(...values);
}

export function scoreThreeChannel(
  clauses: readonly ClauseVector[],
  views: readonly ScoringView[],
  third: ThirdChannel,
  summaryVectors: readonly ArrayLike<number>[],
): number {
  const taskCards = views.filter((view) => view.kind === "task-card");
  const bodies = views.filter((view) => view.kind === "body");
  const fulls = views.filter((view) => view.kind === "full");
  if (taskCards.length === 0 && bodies.length === 0) {
    throw new ExperimentError("run_failed", "A Practice has no task-card or body view to score");
  }
  let weighted = 0;
  let totalWeight = 0;
  for (const clause of clauses) {
    const channels: number[] = [];
    let taskCardBest: number | undefined;
    if (taskCards.length > 0) {
      taskCardBest = best(taskCards.map((view) => dot(clause.vector, view.vector)));
      channels.push(taskCardBest);
    }
    if (bodies.length > 0) {
      const cosines = bodies.map((view) => dot(clause.vector, view.vector));
      const mean = cosines.reduce((sum, value) => sum + value, 0) / cosines.length;
      channels.push(0.5 * best(cosines) + 0.5 * mean);
    }
    if (third === "summary" && summaryVectors.length > 0) {
      channels.push(best(summaryVectors.map((vector) => dot(clause.vector, vector))));
    } else if (third === "duplicate" && taskCardBest !== undefined) {
      channels.push(taskCardBest);
    } else if (third === "full" && fulls.length > 0) {
      channels.push(best(fulls.map((view) => dot(clause.vector, view.vector))));
    }
    weighted += clause.weight * (channels.reduce((sum, value) => sum + value, 0) / channels.length);
    totalWeight += clause.weight;
  }
  if (!(totalWeight > 0)) {
    throw new ExperimentError("run_failed", "Query clause weights have no positive mass");
  }
  return weighted / totalWeight;
}
