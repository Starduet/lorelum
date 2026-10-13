import { describe, expect, test } from "bun:test";

import { fuseRoleEvidence, planRoleQuery } from "./candidate-policy";
import { reduceViewCosines } from "./control-formula";
import { ExperimentError } from "./experiment-error";
import { digestJson, sha256Hex } from "./digest";
import { parseRoleSample, type RoleKind } from "./role-sample";
import {
  roleWeightsOf,
  scoreJointly,
  scoreSeparately,
  type ScoringView,
  type TextVectors,
} from "./role-conditions";

const QUERY_TEXT = "alpha beta gamma delta";

function plan(roles: readonly { role: RoleKind; text: string; group?: string }[]) {
  const sample = {
    formatVersion: 1,
    spanUnit: "utf16-code-unit",
    queryId: "q",
    queryDigest: sha256Hex(QUERY_TEXT),
    analysisVersion: "manual/test",
    analysisKind: "manual",
    roles: roles.map((entry) => ({
      role: entry.role,
      ...(entry.group === undefined ? {} : { actionGroup: entry.group }),
      text: entry.text,
      spans: [{ start: 0, end: 5 }],
      restated: true,
      inference: "test",
    })),
  };
  const planned = planRoleQuery(parseRoleSample(sample, { id: "q", text: QUERY_TEXT }).sample);
  if (planned.status !== "roles") throw new Error("expected roles");
  return planned;
}

const body = (...vector: number[]): ScoringView => ({ kind: "body", vector });
const card = (...vector: number[]): ScoringView => ({ kind: "task-card", vector });
const vectors = (entries: Record<string, number[]>): TextVectors =>
  new Map(Object.entries(entries));

const INTENT_ARTIFACT = plan([
  { role: "intent", text: "A" },
  { role: "artifact", text: "B" },
]);
const AB = vectors({ A: [1, 0], B: [0, 1] });
const HALF = Math.SQRT1_2;

describe("aggregation order", () => {
  // Intent weighs 3 and artifact 2, so the normalized weights are 0.6 and 0.4.
  const weights = roleWeightsOf(INTENT_ARTIFACT, "registered");
  const scattered = [body(1, 0), body(0, 1)];
  const together = [body(HALF, HALF)];

  test("registered weights are normalized over the roles present", () => {
    expect(weights[0]).toBeCloseTo(0.6, 12);
    expect(weights[1]).toBeCloseTo(0.4, 12);
    expect(roleWeightsOf(INTENT_ARTIFACT, "flat")).toEqual([0.5, 0.5]);
  });

  test("Q favors evidence scattered over two views, Q+I the one view supporting both roles", () => {
    // Q: scattered 0.75 (each role: 0.5 best + 0.5 mean of [1, 0]); together 0.7071.
    expect(scoreSeparately(INTENT_ARTIFACT, weights, AB, scattered)).toBeCloseTo(0.75, 12);
    expect(scoreSeparately(INTENT_ARTIFACT, weights, AB, together)).toBeCloseTo(HALF, 12);
    // Q+I: scattered joint cosines [0.6, 0.4] reduce to 0.5 * 0.6 + 0.5 * 0.5 = 0.55.
    expect(scoreJointly(INTENT_ARTIFACT, weights, AB, scattered)).toBeCloseTo(0.55, 12);
    expect(scoreJointly(INTENT_ARTIFACT, weights, AB, together)).toBeCloseTo(HALF, 12);
  });

  test("Q equals the registered policy fusion of per-text production reductions", () => {
    const views = [card(1, 0), body(HALF, HALF), body(0, 1)];
    const evidence = (text: string) => {
      const vector = AB.get(text)!;
      const dotWith = (view: ScoringView) =>
        vector[0]! * view.vector[0]! + vector[1]! * view.vector[1]!;
      return reduceViewCosines(
        views.filter((v) => v.kind === "task-card").map(dotWith),
        views.filter((v) => v.kind === "body").map(dotWith),
      );
    };
    const expected = fuseRoleEvidence(INTENT_ARTIFACT, {
      intent: [evidence("A")],
      artifact: [evidence("B")],
    });
    expect(scoreSeparately(INTENT_ARTIFACT, weights, AB, views)).toBeCloseTo(expected, 12);
  });

  test("with one role text the two conditions are the same number", () => {
    const single = plan([{ role: "intent", text: "A" }]);
    const w = roleWeightsOf(single, "registered");
    const views = [card(0.2, 0.9), body(1, 0), body(-0.5, 0.5)];
    expect(scoreJointly(single, w, AB, views)).toBeCloseTo(
      scoreSeparately(single, w, AB, views),
      12,
    );
  });
});

describe("role evidence handling", () => {
  test("a missing role is omitted and the rest renormalized, not filled with a default", () => {
    const only = plan([{ role: "constraints", text: "A" }]);
    expect(roleWeightsOf(only, "registered")).toEqual([1]);
    expect(scoreSeparately(only, [1], AB, [body(1, 0)])).toBeCloseTo(1, 12);
  });

  test("several action groups share one role by an equal-weight mean over distinct texts", () => {
    const multi = plan([
      { role: "intent", text: "A", group: "first" },
      { role: "intent", text: "B", group: "second" },
      { role: "artifact", text: "A", group: "first" },
    ]);
    // intent texts: A, B; artifact texts: A. Weights 3/5 and 2/5.
    const views = [body(1, 0)];
    const w = roleWeightsOf(multi, "registered");
    // intent: mean(1, 0) = 0.5; artifact: 1 -> 0.6 * 0.5 + 0.4 * 1 = 0.7
    expect(scoreSeparately(multi, w, AB, views)).toBeCloseTo(0.7, 12);
    expect(scoreJointly(multi, w, AB, views)).toBeCloseTo(0.7, 12);
  });

  test("an identical text inside a role counts once; the same text under two roles counts in each", () => {
    const repeated = plan([
      { role: "intent", text: "A", group: "one" },
      { role: "intent", text: "A", group: "two" },
      { role: "artifact", text: "A" },
    ]);
    expect(repeated.roles.find((r) => r.role === "intent")!.texts).toEqual(["A"]);
    expect(repeated.roles.find((r) => r.role === "artifact")!.texts).toEqual(["A"]);
  });

  test("negative cosine stays signed and lowers the score", () => {
    const opposite = vectors({ A: [-1, 0], B: [0, 1] });
    const w = roleWeightsOf(INTENT_ARTIFACT, "registered");
    const views = [body(1, 0)];
    // intent -1 x 0.6 + artifact 0 x 0.4
    expect(scoreSeparately(INTENT_ARTIFACT, w, opposite, views)).toBeCloseTo(-0.6, 12);
    expect(scoreJointly(INTENT_ARTIFACT, w, opposite, views)).toBeCloseTo(-0.6, 12);
  });

  test("full views never score, and a Practice with one channel uses just that channel", () => {
    const full: ScoringView = { kind: "full", vector: [1, 0] };
    const w = roleWeightsOf(INTENT_ARTIFACT, "registered");
    expect(scoreJointly(INTENT_ARTIFACT, w, AB, [full, card(0, 1)])).toBeCloseTo(0.4, 12);
    expect(scoreSeparately(INTENT_ARTIFACT, w, AB, [full, card(0, 1)])).toBeCloseTo(0.4, 12);
  });

  test("a Practice without task-card or body views is a run failure, not a low score", () => {
    const w = roleWeightsOf(INTENT_ARTIFACT, "registered");
    const full: ScoringView = { kind: "full", vector: [1, 0] };
    expect(() => scoreJointly(INTENT_ARTIFACT, w, AB, [full])).toThrow(ExperimentError);
    expect(() => scoreSeparately(INTENT_ARTIFACT, w, AB, [full])).toThrow(ExperimentError);
  });

  test("a planned text without a vector is a run failure", () => {
    const w = roleWeightsOf(INTENT_ARTIFACT, "registered");
    expect(() => scoreSeparately(INTENT_ARTIFACT, w, vectors({ A: [1, 0] }), [body(1, 0)])).toThrow(
      ExperimentError,
    );
  });

  test("scoring is deterministic", () => {
    const w = roleWeightsOf(INTENT_ARTIFACT, "registered");
    const views = [card(0.3, 0.4), body(0.6, 0.1), body(0.2, 0.9)];
    const once = digestJson([
      scoreSeparately(INTENT_ARTIFACT, w, AB, views),
      scoreJointly(INTENT_ARTIFACT, w, AB, views),
    ]);
    const again = digestJson([
      scoreSeparately(INTENT_ARTIFACT, w, AB, views),
      scoreJointly(INTENT_ARTIFACT, w, AB, views),
    ]);
    expect(again).toBe(once);
  });
});
