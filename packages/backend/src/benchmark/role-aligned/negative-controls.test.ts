import { describe, expect, test } from "bun:test";

import { planRoleQuery } from "./candidate-policy";
import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import {
  appendBackground,
  BACKGROUND_SENTENCE,
  buildSegmentPlan,
  segmentQuery,
} from "./negative-controls";
import { parseRoleSample } from "./role-sample";

const QUERY = "verify the reviewer finding before editing the parser module";

function sampleOf(
  query: string,
  roles: readonly { role: "intent" | "artifact" | "constraints"; start: number; end: number }[],
) {
  return parseRoleSample(
    {
      formatVersion: 1,
      spanUnit: "utf16-code-unit",
      queryId: "q",
      queryDigest: sha256Hex(query),
      analysisVersion: "manual/test",
      analysisKind: "manual",
      roles: roles.map((entry) => ({
        role: entry.role,
        text: query.slice(entry.start, entry.end),
        spans: [{ start: entry.start, end: entry.end }],
        restated: false,
        inference: "test",
      })),
    },
    { id: "q", text: query },
  ).sample;
}

describe("appendBackground", () => {
  test("keeps the whole query and adds one fixed sentence in the query language", () => {
    expect(appendBackground(QUERY)).toBe(`${QUERY} ${BACKGROUND_SENTENCE.en}`);
    expect(appendBackground("修复解析器")).toBe(`修复解析器 ${BACKGROUND_SENTENCE.zh}`);
  });
});

describe("segmentQuery", () => {
  test("cuts into the requested number of contiguous pieces without losing text", () => {
    const pieces = segmentQuery(QUERY, 3);
    expect(pieces).toHaveLength(3);
    expect(pieces.join(" ")).toBe(QUERY);
    expect(segmentQuery(QUERY, 3)).toEqual(pieces);
  });

  test("moves a boundary to nearby whitespace so Latin words stay whole", () => {
    for (const piece of segmentQuery(QUERY, 4)) {
      expect(piece.split(" ").every((word) => QUERY.split(" ").includes(word))).toBe(true);
    }
  });

  test("text without whitespace is cut at raw boundaries and never splits a surrogate pair", () => {
    const text = "解析器修复😀流程检查模块";
    const pieces = segmentQuery(text, 3);
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((piece) => !/[\ud800-\udbff]$/u.test(piece))).toBe(true);
  });

  test("a query too short for the count is a protocol error, not a smaller control", () => {
    expect(() => segmentQuery("ab", 5)).toThrow(ExperimentError);
    expect(segmentQuery("one two", 1)).toEqual(["one two"]);
  });
});

describe("buildSegmentPlan", () => {
  const sample = sampleOf(QUERY, [
    { role: "intent", start: 0, end: 6 },
    { role: "artifact", start: 43, end: 58 },
    { role: "constraints", start: 14, end: 36 },
  ]);
  const plan = planRoleQuery(sample);

  test("keeps the role slots and weights while carrying only pieces of the query", () => {
    const segmented = buildSegmentPlan(sample, plan, QUERY);
    if (plan.status !== "roles" || segmented.status !== "roles") throw new Error("expected roles");
    expect(segmented.roles.map((role) => [role.role, role.weight, role.texts.length])).toEqual(
      plan.roles.map((role) => [role.role, role.weight, role.texts.length]),
    );
    const all = segmented.roles.flatMap((role) => role.texts);
    expect(all.join(" ")).not.toBe("");
    expect(all.every((piece) => QUERY.includes(piece))).toBe(true);
  });

  test("fills slots in the order the roles first appear in the query", () => {
    const segmented = buildSegmentPlan(sample, plan, QUERY);
    if (segmented.status !== "roles") throw new Error("expected roles");
    const byRole = Object.fromEntries(segmented.roles.map((r) => [r.role, r.texts[0]!]));
    // intent starts first, constraints second, artifact last.
    expect(QUERY.indexOf(byRole.intent!)).toBeLessThan(QUERY.indexOf(byRole.constraints!));
    expect(QUERY.indexOf(byRole.constraints!)).toBeLessThan(QUERY.indexOf(byRole.artifact!));
  });

  test("a fallback plan stays a fallback", () => {
    const empty = planRoleQuery(sampleOf(QUERY, []));
    expect(buildSegmentPlan(sample, empty, QUERY)).toEqual(empty);
  });
});
