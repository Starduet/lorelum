import { describe, expect, test } from "bun:test";

import {
  ATTRIBUTION_CONDITIONS,
  compareScoredPractices,
  fuseRoleEvidence,
  planRoleQuery,
  ROLE_POLICY,
  ROLE_POLICY_DIGEST,
  ROLE_WEIGHTS,
} from "./candidate-policy";
import { digestJson } from "./digest";
import { ExperimentError } from "./experiment-error";
import type { RoleAnnotation, RoleKind, RoleSample } from "./role-sample";

function annotation(role: RoleKind, text: string, actionGroup?: string): RoleAnnotation {
  return {
    role,
    text,
    spans: [{ start: 0, end: 1 }],
    restated: false,
    inference: "fixture",
    ...(actionGroup === undefined ? {} : { actionGroup }),
  };
}

function sample(roles: readonly RoleAnnotation[]): RoleSample {
  return {
    formatVersion: 1,
    spanUnit: "utf16-code-unit",
    queryId: "q",
    queryDigest: "0".repeat(64),
    analysisVersion: "manual/1",
    analysisKind: "manual",
    roles: [...roles],
  };
}

function presentPlan(roles: readonly RoleAnnotation[]) {
  const plan = planRoleQuery(sample(roles));
  if (plan.status !== "roles") throw new Error("expected a role plan");
  return plan;
}

describe("planRoleQuery", () => {
  test("renormalizes weights over the roles present and sums to one", () => {
    const plan = presentPlan([annotation("intent", "a"), annotation("domain", "b")]);
    expect(plan.roles.map((entry) => entry.role)).toEqual(["intent", "domain"]);
    expect(plan.roles[0]?.weight).toBeCloseTo(3 / 4, 12);
    expect(plan.roles[1]?.weight).toBeCloseTo(1 / 4, 12);

    const all = presentPlan(
      (["intent", "moment", "artifact", "constraints", "domain"] as const).map((role) =>
        annotation(role, role),
      ),
    );
    expect(all.roles.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(1, 12);
    expect(all.roles.find((entry) => entry.role === "constraints")?.weight).toBeCloseTo(
      ROLE_WEIGHTS.constraints / 9,
      12,
    );
  });

  test("a required constraint is never weighted below the artifact it conditions", () => {
    expect(ROLE_WEIGHTS.constraints).toBeGreaterThanOrEqual(ROLE_WEIGHTS.artifact);
    expect(ROLE_WEIGHTS.constraints).toBeGreaterThan(ROLE_WEIGHTS.domain);
    expect(ROLE_WEIGHTS.intent).toBeGreaterThan(ROLE_WEIGHTS.constraints);
  });

  test("collapses identical text inside a role but keeps it in each role", () => {
    const plan = presentPlan([
      annotation("intent", "verify", "a"),
      annotation("intent", "verify", "b"),
      annotation("intent", "edit", "b"),
      annotation("moment", "verify"),
    ]);
    expect(plan.roles.find((entry) => entry.role === "intent")?.texts).toEqual(["edit", "verify"]);
    expect(plan.roles.find((entry) => entry.role === "moment")?.texts).toEqual(["verify"]);
  });

  test("never scores unknown, and falls back when nothing scorable remains", () => {
    expect(planRoleQuery(sample([]))).toEqual({ status: "fallback", reason: "no-scorable-role" });
    expect(planRoleQuery(sample([annotation("unknown", "??")]))).toEqual({
      status: "fallback",
      reason: "no-scorable-role",
    });
    const plan = presentPlan([annotation("unknown", "??"), annotation("artifact", "pr")]);
    expect(plan.roles.map((entry) => entry.role)).toEqual(["artifact"]);
    expect(plan.roles[0]?.weight).toBe(1);
  });

  test("is deterministic for the same roles in any annotation order", () => {
    const roles = [annotation("domain", "d"), annotation("intent", "i"), annotation("intent", "j")];
    expect(planRoleQuery(sample(roles))).toEqual(planRoleQuery(sample([...roles].reverse())));
  });
});

describe("fuseRoleEvidence", () => {
  test("averages texts inside a role, then takes the weighted mean across roles", () => {
    const plan = presentPlan([
      annotation("intent", "i1"),
      annotation("intent", "i2"),
      annotation("domain", "d"),
    ]);
    // intent weight 3/4 with mean(0.8, 0.4) = 0.6; domain weight 1/4 with 0.2.
    expect(fuseRoleEvidence(plan, { intent: [0.8, 0.4], domain: [0.2] })).toBeCloseTo(
      0.75 * 0.6 + 0.25 * 0.2,
      12,
    );
  });

  test("keeps negative cosine signed instead of clamping it", () => {
    const plan = presentPlan([annotation("intent", "i"), annotation("domain", "d")]);
    expect(fuseRoleEvidence(plan, { intent: [0.4], domain: [-0.2] })).toBeCloseTo(
      0.75 * 0.4 + 0.25 * -0.2,
      12,
    );
  });

  test("rejects evidence that does not match the plan instead of guessing", () => {
    const plan = presentPlan([annotation("intent", "i1"), annotation("intent", "i2")]);
    expect(() => fuseRoleEvidence(plan, { intent: [0.5] })).toThrow(ExperimentError);
    expect(() => fuseRoleEvidence(plan, {})).toThrow(ExperimentError);
    expect(() => fuseRoleEvidence(plan, { intent: [0.5, Number.NaN] })).toThrow(ExperimentError);
  });
});

describe("compareScoredPractices", () => {
  test("orders by score, then by Practice ID in code-unit order", () => {
    const ranked = [
      { practiceId: "b", score: 0.5 },
      { practiceId: "B", score: 0.5 },
      { practiceId: "a", score: 0.7 },
      { practiceId: "c", score: 0.1 },
    ].sort(compareScoredPractices);
    expect(ranked.map((entry) => entry.practiceId)).toEqual(["a", "B", "b", "c"]);
  });
});

describe("registered conditions", () => {
  test("control changes nothing and every later condition declares its change", () => {
    expect(ATTRIBUTION_CONDITIONS.map((condition) => condition.id)).toEqual([
      "control",
      "Q",
      "Q+I",
      "Q+I+D",
    ]);
    expect(ATTRIBUTION_CONDITIONS[0]?.changes).toEqual([]);
    for (const condition of ATTRIBUTION_CONDITIONS.slice(1)) {
      expect(condition.changes.length).toBeGreaterThan(0);
    }
  });

  test("only the final condition changes the document representation", () => {
    const changed = ATTRIBUTION_CONDITIONS.filter(
      (condition) => condition.documentRepresentation !== "unchanged",
    ).map((condition) => condition.id);
    expect(changed).toEqual(["control", "Q+I+D"]);
  });

  test("the policy digest covers the registered rules", () => {
    expect(ROLE_POLICY_DIGEST).toBe(digestJson(ROLE_POLICY));
    expect(ROLE_POLICY_DIGEST).not.toBe(digestJson({ ...ROLE_POLICY, tieBreak: "changed" }));
  });
});
