import { describe, expect, test } from "bun:test";

import {
  evaluateGates,
  type DevelopmentMetrics,
  type GateReport,
  type PilotMetrics,
} from "./role-scoring";
import type { CompleteRoleRunManifest } from "./role-run-manifest";

function manifest(overrides: {
  usage?: "development" | "pilot";
  independent?: boolean;
  mismatches?: number;
}): CompleteRoleRunManifest {
  return {
    experiment: { usage: overrides.usage ?? "pilot" },
    inputs: { roleProvenance: { independentOfTargets: overrides.independent ?? true } },
    scoring: { resultLimit: 5 },
    controlComparison: {
      pairCount: 4850,
      maxAbsDelta: 0,
      mismatchCount: overrides.mismatches ?? 0,
    },
  } as unknown as CompleteRoleRunManifest;
}

function development(values: Partial<DevelopmentMetrics>): DevelopmentMetrics {
  return {
    hitAt: { "5": 45 },
    mrr: 0.763671,
    scopeErrorCases: 2,
    forbiddenBeforeCoreCases: 1,
    cases: [],
    ...values,
  };
}

function pilot(values: Partial<PilotMetrics>): PilotMetrics {
  return {
    queryCount: 30,
    targetedQueries: 26,
    success: 10,
    fullyServed: 10,
    anyHelp: 14,
    forbiddenQueries: 3,
    unlabelledSlots: 60,
    undeterminedSlots: 5,
    noTargetQueriesWithForbidden: 0,
    cases: [],
    ...values,
  };
}

const control = { development: development({}), pilot: pilot({}) };

function verdictOf(input: {
  dev?: Partial<DevelopmentMetrics>;
  pilot?: Partial<PilotMetrics>;
  controlPilot?: Partial<PilotMetrics>;
  manifest?: Parameters<typeof manifest>[0];
  labelsIndependent?: boolean;
}): GateReport {
  return evaluateGates({
    candidate: "Q",
    manifest: manifest(input.manifest ?? {}),
    development: { control: control.development, candidate: development(input.dev ?? {}) },
    pilot: {
      control: pilot(input.controlPilot ?? {}),
      candidate: pilot({ success: 12, ...input.pilot }),
      labelsIndependent: input.labelsIndependent ?? true,
    },
  });
}

function status(report: GateReport, id: string): string {
  return report.criteria.find((criterion) => criterion.id === id)!.status;
}

describe("evaluateGates", () => {
  test("a strict, independent, comparable pilot gain with no old-set loss passes", () => {
    expect(verdictOf({}).verdict).toBe("pass");
  });

  test("equal success is not an improvement", () => {
    expect(status(verdictOf({ pilot: { success: 10 } }), "2-pilot-improvement")).toBe("fail");
  });

  test("more queries with a forbidden Practice fails even when success rises", () => {
    const report = verdictOf({ pilot: { forbiddenQueries: 4 } });
    expect(status(report, "2-pilot-improvement")).toBe("fail");
    expect(report.verdict).toBe("fail");
  });

  test("incomparable label coverage makes the pilot uncertain rather than a pass or a fail", () => {
    // 30 queries x 5 slots = 150; a gap above 10% is 16 or more.
    expect(status(verdictOf({ pilot: { unlabelledSlots: 80 } }), "2-pilot-improvement")).toBe(
      "uncertain",
    );
    expect(status(verdictOf({ pilot: { unlabelledSlots: 70 } }), "2-pilot-improvement")).toBe(
      "pass",
    );
  });

  test("dependent annotation, dependent labels, a development run or a small sample can never pass", () => {
    expect(verdictOf({ manifest: { independent: false } }).verdict).toBe("uncertain");
    expect(verdictOf({ labelsIndependent: false }).verdict).toBe("uncertain");
    expect(verdictOf({ manifest: { usage: "development" } }).verdict).toBe("uncertain");
    expect(verdictOf({ controlPilot: { queryCount: 23 } }).verdict).toBe("uncertain");
  });

  test("a loss on the old set fails whatever the pilot shows", () => {
    for (const dev of [
      { hitAt: { "5": 44 } },
      { mrr: 0.76 },
      { scopeErrorCases: 3 },
      { forbiddenBeforeCoreCases: 2 },
    ]) {
      const report = verdictOf({ dev });
      expect(status(report, "3-development-regression")).toBe("fail");
      expect(report.verdict).toBe("fail");
    }
  });

  test("a control mismatch stops the comparison", () => {
    expect(status(verdictOf({ manifest: { mismatches: 1 } }), "1-control-reproduced")).toBe("fail");
  });

  test("without a pilot or a development run the verdict stays uncertain", () => {
    const report = evaluateGates({ candidate: "Q+I", manifest: manifest({}) });
    expect(report.verdict).toBe("uncertain");
  });
});
