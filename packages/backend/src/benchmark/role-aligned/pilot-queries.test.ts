import { describe, expect, test } from "bun:test";

import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import { checkPilotIntake, PILOT_SIZE, serializeQueries } from "./pilot-queries";

function entry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `t-${index}`,
    query: `task number ${index} differs in wording`,
    taskCluster: `c-${index}`,
    language: "en",
    categories: ["state-or-condition"],
    source: {
      kind: "real-task",
      description: "a task the collector had",
      collectedBlindToTargets: true,
    },
    ...overrides,
  };
}

function file(cases: unknown[]) {
  return { formatVersion: 1, revision: "p1", usage: "pilot", cases };
}

const many = (count: number) => Array.from({ length: count }, (_, index) => entry(index));

describe("checkPilotIntake", () => {
  test("a clean set reports counts, a pinned digest, and the coverage it lacks", () => {
    const report = checkPilotIntake(file(many(PILOT_SIZE.minimum)));
    expect(report.errors).toEqual([]);
    expect(report.caseCount).toBe(24);
    expect(report.clusterCount).toBe(24);
    expect(report.queriesSha256).toBe(sha256Hex(serializeQueries(report.queriesJson)));
    expect(report.warnings.some((warning) => warning.includes("no-target"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("Chinese"))).toBe(true);
  });

  test("same-origin rewrites share a cluster and do not count as independent tasks", () => {
    const cases = [...many(23), entry(99, { taskCluster: "c-0" })];
    const report = checkPilotIntake(file(cases));
    expect(report.caseCount).toBe(24);
    expect(report.clusterCount).toBe(23);
    expect(
      report.warnings.some((warning) => warning.includes("23 independent task clusters")),
    ).toBe(true);
  });

  test("a perturbation or a task collected with knowledge of targets cannot be frozen as a pilot task", () => {
    const report = checkPilotIntake(
      file([
        entry(1, {
          source: {
            kind: "perturbation",
            description: "edited",
            collectedBlindToTargets: true,
            derivedFrom: "t-2",
          },
        }),
        entry(2, {
          source: { kind: "real-task", description: "x", collectedBlindToTargets: false },
        }),
      ]),
    );
    expect(report.errors).toHaveLength(2);
    expect(report.queriesJson.cases.map((c) => c.id)).toEqual(["t-2"]);
  });

  test("duplicate ids and repeated text are errors", () => {
    const report = checkPilotIntake(
      file([
        entry(1),
        entry(1),
        entry(2, { query: "  TASK number 3   differs in wording" }),
        entry(3),
      ]),
    );
    expect(report.errors.some((error) => error.includes("duplicate id t-1"))).toBe(true);
    expect(report.errors.some((error) => error.includes("repeats the text"))).toBe(true);
  });

  test("a malformed file is rejected outright, not reported as a miss", () => {
    expect(() => checkPilotIntake({ formatVersion: 2 })).toThrow(ExperimentError);
    expect(() => checkPilotIntake(file([{ id: "a" }]))).toThrow(ExperimentError);
    expect(() => checkPilotIntake(file([entry(1, { unexpected: true })]))).toThrow(ExperimentError);
  });
});
