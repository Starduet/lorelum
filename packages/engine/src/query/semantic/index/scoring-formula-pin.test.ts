import { expect, test } from "bun:test";

import type { SemanticIndexVector } from "./database";
import { scoreSemanticPractice, type SemanticQueryVector } from "./reader";

/**
 * Drift guard for the semantic scoring formula. Verification §21/§22 measured
 * every simplification of this formula on the frozen 50-case suite and found
 * each element load-bearing: removing the clause split, the body max/mean
 * evidence mix, or the task-card half of the clause score lowers hit@5 and
 * MRR. Because the formula is saturated, further changes drift instead of
 * improve. These golden numbers pin the exact behavior: changing them
 * requires a deliberate decision plus a single-variable ablation recorded in
 * the change's verification.md.
 */
function view(
  viewId: string,
  viewKind: SemanticIndexVector["viewKind"],
  vector: readonly number[],
): SemanticIndexVector {
  return {
    viewId,
    viewKind,
    viewOrdinal: Number(/:(\d+)$/.exec(viewId)?.[1] ?? 0),
    contentDigest: "a".repeat(64),
    projectionDigest: "b".repeat(64),
    vector: Float32Array.from(vector),
  };
}

function query(viewId: string, vector: readonly number[], weight: number): SemanticQueryVector {
  return { viewId, vector: Float32Array.from(vector), weight };
}

test("pins the aggregate scoring formula on golden vectors", () => {
  const queries = [query("clause:0000", [1, 0], 1), query("clause:0001", [0, 1], 2)];

  // task-card = [0.98, 0.2] (unit); body = [0.6, 0.8] and [0, 1] (unit).
  // clause 0: task-card max 0.98; body max 0.6, mean 0.3, evidence 0.45;
  //   clause score (0.98 + 0.45) / 2 = 0.7148979.
  // clause 1: task-card max 0.2; body max 1, mean 0.9, evidence 0.95;
  //   clause score (0.2 + 0.95) / 2 = 0.575.
  // Practice score = (1 * 0.7148979 + 2 * 0.575) / 3 = 0.6216326.
  const scored = scoreSemanticPractice(
    queries,
    [
      view("full:0000", "full", [0.9797958971132712, 0.2]),
      view("task-card:0000", "task-card", [0.9797958971132712, 0.2]),
      view("body:0000", "body", [0.6, 0.8]),
      view("body:0001", "body", [0, 1]),
    ],
    2,
  );
  expect(scored.score).toBeCloseTo(0.62163265, 7);
  // The unique best cosine is clause 1 against body:0001.
  expect(scored.bestViewId).toBe("body:0001");
  expect(scored.bestViewKind).toBe("body");
  expect(scored.bestViewOrdinal).toBe(1);

  // clause 0: task-card max 0; body evidence 0.6; clause score 0.3.
  // clause 1: task-card max 1; body max 0.8, mean 0.8, evidence 0.8;
  //   clause score 0.9.
  // Practice score = (1 * 0.3 + 2 * 0.9) / 3 = 0.7.
  const other = scoreSemanticPractice(
    queries,
    [view("task-card:0000", "task-card", [0, 1]), view("body:0000", "body", [0.6, 0.8])],
    2,
  );
  expect(other.score).toBeCloseTo(0.7, 7);
  expect(other.bestViewId).toBe("task-card:0000");
});
