import { describe, expect, test } from "bun:test";

import type { SemanticIndexVector } from "../../../../engine/src/query/semantic/index/database";
import { scoreSemanticPractice } from "../../../../engine/src/query/semantic/index/reader";
import { recomputeControlScore, type FormulaView } from "./control-formula";
import { ExperimentError } from "./experiment-error";

function unit(values: readonly number[]): Float32Array {
  const norm = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / norm));
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("recomputeControlScore", () => {
  test("matches the pinned golden numbers", () => {
    const clauses = [
      { viewId: "clause:0000", vector: Float32Array.from([1, 0]), weight: 1 },
      { viewId: "clause:0001", vector: Float32Array.from([0, 1]), weight: 2 },
    ];
    const first: FormulaView[] = [
      { viewId: "full:0000", kind: "full", vector: Float32Array.from([0.9797958971132712, 0.2]) },
      {
        viewId: "task-card:0000",
        kind: "task-card",
        vector: Float32Array.from([0.9797958971132712, 0.2]),
      },
      { viewId: "body:0000", kind: "body", vector: Float32Array.from([0.6, 0.8]) },
      { viewId: "body:0001", kind: "body", vector: Float32Array.from([0, 1]) },
    ];
    expect(recomputeControlScore(clauses, first)).toBeCloseTo(0.62163265, 7);
    const second: FormulaView[] = [
      { viewId: "task-card:0000", kind: "task-card", vector: Float32Array.from([0, 1]) },
      { viewId: "body:0000", kind: "body", vector: Float32Array.from([0.6, 0.8]) },
    ];
    expect(recomputeControlScore(clauses, second)).toBeCloseTo(0.7, 7);
  });

  test("agrees with the production scorer on random Practices within 1e-6", () => {
    const random = mulberry32(20261008);
    const dimensions = 12;
    const vector = () => unit(Array.from({ length: dimensions }, () => random() * 2 - 1));
    let worst = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const clauses = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index) => ({
        viewId: `clause:${index.toString().padStart(4, "0")}`,
        vector: vector(),
        weight: 0.25 + random() * 2,
      }));
      const taskCards = Math.floor(random() * 3);
      const bodies = Math.floor(random() * 6);
      const shaped = taskCards + bodies === 0 ? { taskCards: 1, bodies } : { taskCards, bodies };
      const views: SemanticIndexVector[] = [
        { viewId: "full:0000", viewKind: "full" as const, viewOrdinal: 0 },
        ...Array.from({ length: shaped.taskCards }, (_, index) => ({
          viewId: `task-card:${index.toString().padStart(4, "0")}`,
          viewKind: "task-card" as const,
          viewOrdinal: index,
        })),
        ...Array.from({ length: shaped.bodies }, (_, index) => ({
          viewId: `body:${index.toString().padStart(4, "0")}`,
          viewKind: "body" as const,
          viewOrdinal: index,
        })),
      ].map((view) => ({
        ...view,
        contentDigest: "a".repeat(64),
        projectionDigest: "b".repeat(64),
        vector: vector(),
      }));
      const production = scoreSemanticPractice(clauses, views, dimensions).score;
      const independent = recomputeControlScore(
        clauses,
        views.map((view) => ({ viewId: view.viewId, kind: view.viewKind, vector: view.vector })),
      );
      worst = Math.max(worst, Math.abs(production - independent));
    }
    expect(worst).toBeLessThanOrEqual(1e-6);
  });

  test("never lets a full view raise the score", () => {
    const clauses = [{ viewId: "clause:0000", vector: Float32Array.from([1, 0]), weight: 1 }];
    const base: FormulaView[] = [
      { viewId: "task-card:0000", kind: "task-card", vector: Float32Array.from([0, 1]) },
      { viewId: "body:0000", kind: "body", vector: Float32Array.from([0, 1]) },
    ];
    const withFull: FormulaView[] = [
      { viewId: "full:0000", kind: "full", vector: Float32Array.from([1, 0]) },
      ...base,
    ];
    expect(recomputeControlScore(clauses, withFull)).toBe(recomputeControlScore(clauses, base));
  });

  test("reports a Practice with nothing scorable as an experiment error", () => {
    const clauses = [{ viewId: "clause:0000", vector: Float32Array.from([1, 0]), weight: 1 }];
    expect(() =>
      recomputeControlScore(clauses, [
        { viewId: "full:0000", kind: "full", vector: Float32Array.from([1, 0]) },
      ]),
    ).toThrow(ExperimentError);
  });
});
