import { expect, test } from "bun:test";

import { COST_BUDGET, COST_BUDGET_DIGEST } from "./cost-budget";
import { digestJson } from "./digest";

test("the end-to-end query limit covers its own parts, so the limits cannot contradict each other", () => {
  const parts =
    COST_BUDGET.analyzer.addedMsP95 +
    COST_BUDGET.query.encodeMsP95 +
    COST_BUDGET.query.scoringMsMean;
  expect(parts).toBeLessThanOrEqual(COST_BUDGET.endToEnd.queryMsP95);
});

test("an analyzer is bounded to one request-level call and never runs per Practice", () => {
  expect(COST_BUDGET.analyzer.callsPerQuery).toBe(1);
  expect(COST_BUDGET.analyzer.callsPerPractice).toBe(0);
});

test("Q and Q+I add no document encoding", () => {
  expect(COST_BUDGET.document.addedEncodedViewFractionQ).toBe(0);
  expect(COST_BUDGET.document.addedEncodedViewFractionQID).toBeGreaterThan(0);
});

test("the digest changes with any limit", () => {
  expect(COST_BUDGET_DIGEST).toBe(digestJson(COST_BUDGET));
  expect(COST_BUDGET_DIGEST).not.toBe(
    digestJson({ ...COST_BUDGET, query: { ...COST_BUDGET.query, encodeMsP95: 166 } }),
  );
});
