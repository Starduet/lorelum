import { describe, expect, test } from "bun:test";

import { ExperimentError } from "./experiment-error";
import type { ScoringView } from "./role-conditions";
import { scoreThreeChannel } from "./summary-conditions";

const clause = { vector: [1, 0], weight: 1 };
const taskCard: ScoringView = { kind: "task-card", vector: [0.6, 0.8] }; // cosine 0.6
const body: ScoringView = { kind: "body", vector: [0.2, 0.98] }; // cosine 0.2
const full: ScoringView = { kind: "full", vector: [0.9, 0.1] }; // cosine 0.9
const views = [taskCard, body, full];

function bodyChannel(...cosines: number[]): number {
  const mean = cosines.reduce((sum, value) => sum + value, 0) / cosines.length;
  return 0.5 * Math.max(...cosines) + 0.5 * mean;
}

describe("scoreThreeChannel", () => {
  test("summary adds its best cosine as a third equal-share channel", () => {
    const score = scoreThreeChannel([clause], views, "summary", [
      [0.3, 0],
      [0.5, 0],
    ]);
    expect(score).toBeCloseTo((0.6 + 0.2 + 0.5) / 3, 12);
  });

  test("duplicate repeats the task-card channel and adds no new information", () => {
    expect(scoreThreeChannel([clause], views, "duplicate", [])).toBeCloseTo(
      (0.6 + 0.2 + 0.6) / 3,
      12,
    );
  });

  test("full adds the whole-Practice vector, which the production score never uses", () => {
    expect(scoreThreeChannel([clause], views, "full", [])).toBeCloseTo((0.6 + 0.2 + 0.9) / 3, 12);
  });

  test("body channel keeps the production half-best half-mean reduction", () => {
    const bodies: ScoringView[] = [
      { kind: "body", vector: [0.8, 0.6] }, // cosine 0.8
      { kind: "body", vector: [0, 1] }, // cosine 0
    ];
    const score = scoreThreeChannel([clause], [taskCard, ...bodies], "duplicate", []);
    expect(score).toBeCloseTo((0.6 + bodyChannel(0.8, 0) + 0.6) / 3, 12);
  });

  test("a negative cosine lowers the score instead of being clamped", () => {
    const negative: ScoringView = { kind: "task-card", vector: [-1, 0] };
    expect(scoreThreeChannel([clause], [negative, body], "duplicate", [])).toBeCloseTo(
      (-1 + 0.2 - 1) / 3,
      12,
    );
  });

  test("a missing channel leaves the others at equal shares", () => {
    expect(scoreThreeChannel([clause], [taskCard, body], "summary", [])).toBeCloseTo(0.4, 12);
    expect(scoreThreeChannel([clause], [taskCard], "full", [])).toBeCloseTo(0.6, 12);
  });

  test("clause weights average the clause scores", () => {
    const other = { vector: [0, 1], weight: 3 };
    const a = scoreThreeChannel([clause], views, "duplicate", []);
    const b = scoreThreeChannel([other], views, "duplicate", []);
    expect(scoreThreeChannel([clause, other], views, "duplicate", [])).toBeCloseTo(
      (a + 3 * b) / 4,
      12,
    );
  });

  test("a Practice without task-card and body views is a run failure", () => {
    expect(() => scoreThreeChannel([clause], [full], "full", [])).toThrow(ExperimentError);
  });

  test("non-positive total weight is a run failure", () => {
    expect(() => scoreThreeChannel([{ vector: [1, 0], weight: 0 }], views, "summary", [])).toThrow(
      ExperimentError,
    );
  });
});
