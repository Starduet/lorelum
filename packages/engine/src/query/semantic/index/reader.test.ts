import { expect, test } from "bun:test";

import type { SemanticIndexVector } from "./database";
import { scoreSemanticPractice, type SemanticQueryVector } from "./reader";

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

function query(viewId: string, vector: readonly number[], weight = 1): SemanticQueryVector {
  return { viewId, vector: Float32Array.from(vector), weight };
}

test("does not score the full context view and balances task-card with body", () => {
  const scored = scoreSemanticPractice(
    [query("clause", [1, 0])],
    [
      view("full:0000", "full", [0.8, 0.6]),
      view("task-card:0000", "task-card", [0.6, 0.8]),
      view("body:0000", "body", [0, 1]),
    ],
    2,
  );

  expect(scored).toMatchObject({
    bestViewId: "task-card:0000",
    bestViewKind: "task-card",
    bestViewOrdinal: 0,
  });
  // `full` is ignored. task-card scores 0.6 and body scores 0.0, so the clause
  // score is their mean; with one clause the Practice score is that mean.
  expect(scored.score).toBeCloseTo(0.3, 6);
});

test("extra body chunks cannot linearly increase the Practice score", () => {
  const queries = [query("clause", [0.8, 0.6])];
  const baseline = [view("body:0000", "body", [1, 0])];
  const manyChunks = [
    ...baseline,
    view("body:0001", "body", [1, 0]),
    view("body:0002", "body", [1, 0]),
  ];

  expect(scoreSemanticPractice(queries, baseline, 2).score).toBeCloseTo(0.8, 6);
  expect(scoreSemanticPractice(queries, manyChunks, 2).score).toBeCloseTo(0.8, 6);
});

test("keeps a local body fragment visible instead of averaging it away", () => {
  const queries = [query("clause", [1, 0])];
  const views = [
    view("task-card:0000", "task-card", [0.2, 0.9797958971132712]),
    view("body:0000", "body", [0.8, 0.6]),
    view("body:0001", "body", [0, 1]),
  ];

  // task-card = 0.2; body mean = 0.4; body maximum = 0.8; body evidence = 0.6;
  // the clause score is (0.2 + 0.6) / 2 = 0.4.
  expect(scoreSemanticPractice(queries, views, 2).score).toBeCloseTo(0.4, 6);
});

test("a background-only clause cannot carry the whole Practice", () => {
  const scored = scoreSemanticPractice(
    [query("clause:0000", [1, 0]), query("clause:0001", [0, 1])],
    [view("body:0000", "body", [1, 0])],
    2,
  );

  // One clause scores 1.0 and the other 0.0, so the weighted mean is 0.5: the
  // background-only match is diluted by the clause it fails, not carried.
  expect(scored.score).toBeCloseTo(0.5, 6);
});

test("a clause that only scores well raises the Practice without carrying it", () => {
  const both = scoreSemanticPractice(
    [query("clause:0000", [1, 0]), query("clause:0001", [0.6, 0.8])],
    [view("body:0000", "body", [1, 0])],
    2,
  );
  const backgroundOnly = scoreSemanticPractice(
    [query("clause:0000", [1, 0]), query("clause:0001", [0, 1])],
    [view("body:0000", "body", [1, 0])],
    2,
  );

  expect(both.score).toBeGreaterThan(backgroundOnly.score);
});

test("clause weights scale the single-pass aggregation", () => {
  const scored = scoreSemanticPractice(
    [query("clause:0000", [1, 0], 3), query("clause:0001", [0, 1], 1)],
    [view("body:0000", "body", [1, 0])],
    2,
  );

  // Weighted mean = (3 * 1 + 1 * 0) / 4 = 0.75.
  expect(scored.score).toBeCloseTo(0.75, 6);
});

test("scoring is independent of the order views are read in", () => {
  const queries = [query("clause", [1, 0])];
  const shuffled = [
    view("body:0001", "body", [0.1, 0.99498743710662]),
    view("task-card:0000", "task-card", [0.6, 0.8]),
    view("body:0000", "body", [0.2, 0.9797958971132712]),
  ];
  const ordered = [
    view("task-card:0000", "task-card", [0.6, 0.8]),
    view("body:0000", "body", [0.2, 0.9797958971132712]),
    view("body:0001", "body", [0.1, 0.99498743710662]),
  ];

  expect(scoreSemanticPractice(queries, shuffled, 2).score).toBeCloseTo(
    scoreSemanticPractice(queries, ordered, 2).score,
    12,
  );
});

test("a Practice without a scorable view fails instead of scoring the full anchor", () => {
  expect(() =>
    scoreSemanticPractice([query("clause", [1, 0])], [view("full:0000", "full", [1, 0])], 2),
  ).toThrow("no scorable document views");
});

test("rejects a query vector whose dimensions do not match the index", () => {
  expect(() =>
    scoreSemanticPractice(
      [query("clause", [1, 0, 0])],
      [view("task-card:0000", "task-card", [1, 0])],
      2,
    ),
  ).toThrow("view is invalid");
});
