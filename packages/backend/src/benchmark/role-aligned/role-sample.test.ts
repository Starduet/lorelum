import { describe, expect, test } from "bun:test";

import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import { parseRoleSample, RoleSampleError, type RoleSampleIssueCode } from "./role-sample";

const TEXT = "A reviewer reported a finding; verify it before editing the PR body.";
const QUERY = { id: "q-1", text: TEXT };

function slice(start: number, end: number): string {
  return TEXT.slice(start, end);
}

function sample(roles: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    spanUnit: "utf16-code-unit",
    queryId: QUERY.id,
    queryDigest: sha256Hex(TEXT),
    analysisVersion: "manual/1",
    analysisKind: "manual",
    roles,
    ...overrides,
  };
}

function role(overrides: Record<string, unknown> = {}) {
  const start = TEXT.indexOf("verify it");
  const end = start + "verify it".length;
  return {
    role: "intent",
    text: slice(start, end),
    spans: [{ start, end }],
    restated: false,
    inference: "the imperative names the current action",
    ...overrides,
  };
}

function issueCodes(raw: unknown, query = QUERY): RoleSampleIssueCode[] {
  try {
    parseRoleSample(raw, query);
  } catch (error) {
    if (error instanceof RoleSampleError) return error.issues.map((issue) => issue.code);
    throw error;
  }
  return [];
}

describe("parseRoleSample", () => {
  test("accepts a sample with no roles and with a single role", () => {
    expect(parseRoleSample(sample([]), QUERY).sample.roles).toEqual([]);
    expect(parseRoleSample(sample([role()]), QUERY).sample.roles).toHaveLength(1);
  });

  test("accepts several actions, several roles on one fragment, and unknown", () => {
    const edit = TEXT.indexOf("editing");
    const start = TEXT.indexOf("verify it");
    const validated = parseRoleSample(
      sample([
        role({ actionGroup: "check" }),
        role({ role: "moment", actionGroup: "check", inference: "state precedes editing" }),
        role({
          role: "intent",
          actionGroup: "edit",
          text: "editing",
          spans: [{ start: edit, end: edit + 7 }],
        }),
        role({
          role: "unknown",
          text: "A reviewer",
          spans: [{ start: 0, end: 10 }],
          inference: "not assignable",
        }),
        role({
          role: "constraints",
          actionGroup: "edit",
          text: "it before editing",
          spans: [
            { start: start + 7, end: start + 9 },
            { start: edit - 7, end: edit + 7 },
          ],
          restated: false,
          inference: "must hold before the edit",
        }),
      ]),
      QUERY,
    );
    expect(validated.sample.roles.map((entry) => entry.role)).toEqual([
      "intent",
      "intent",
      "moment",
      "constraints",
      "unknown",
    ]);
  });

  test("a restatement is allowed only when it differs from its cited source", () => {
    const start = TEXT.indexOf("verify it");
    const spans = [{ start, end: start + 9 }];
    expect(
      parseRoleSample(
        sample([role({ text: "confirm the finding is real", restated: true, spans })]),
        QUERY,
      ).sample.roles[0]?.restated,
    ).toBe(true);
    expect(issueCodes(sample([role({ restated: true })]))).toEqual(["restatement_identical"]);
  });

  test("rejects text that does not match its source fragments", () => {
    expect(issueCodes(sample([role({ text: "verify the finding" })]))).toEqual(["text_mismatch"]);
  });

  test("rejects spans outside the query, empty, unordered, or overlapping", () => {
    expect(issueCodes(sample([role({ spans: [{ start: 5, end: TEXT.length + 1 }] })]))).toEqual([
      "span_out_of_range",
    ]);
    expect(issueCodes(sample([role({ spans: [{ start: 5, end: 5 }] })]))).toEqual([
      "span_out_of_range",
    ]);
    expect(
      issueCodes(
        sample([
          role({
            restated: true,
            spans: [
              { start: 10, end: 20 },
              { start: 15, end: 25 },
            ],
          }),
        ]),
      ),
    ).toEqual(["span_order"]);
  });

  test("measures offsets in UTF-16 code units and rejects a split surrogate pair", () => {
    const text = "check 😀 now";
    const query = { id: "q-emoji", text };
    const emoji = text.indexOf("😀");
    const base = {
      formatVersion: 1,
      spanUnit: "utf16-code-unit",
      queryId: query.id,
      queryDigest: sha256Hex(text),
      analysisVersion: "manual/1",
      analysisKind: "manual",
    };
    const whole = {
      role: "artifact",
      text: "😀",
      spans: [{ start: emoji, end: emoji + 2 }],
      restated: false,
      inference: "the pictograph is the artifact",
    };
    expect(parseRoleSample({ ...base, roles: [whole] }, query).sample.roles).toHaveLength(1);
    const split = { ...whole, text: "\ud83d", spans: [{ start: emoji, end: emoji + 1 }] };
    expect(issueCodes({ ...base, roles: [split] }, query)).toEqual(["span_splits_surrogate_pair"]);
  });

  test("rejects a sample for another query or a changed query text", () => {
    expect(issueCodes(sample([role()], { queryId: "other" }))).toEqual(["query_id_mismatch"]);
    expect(issueCodes(sample([role()], { queryDigest: sha256Hex("changed") }))).toEqual([
      "query_digest_mismatch",
    ]);
  });

  test("rejects duplicate roles but allows one fragment under two different roles", () => {
    expect(issueCodes(sample([role(), role()]))).toEqual(["duplicate_role"]);
    expect(
      issueCodes(sample([role(), role({ role: "moment", inference: "also states timing" })])),
    ).toEqual([]);
  });

  test("rejects an unknown fragment that is restated or grouped, and dangling groups", () => {
    expect(issueCodes(sample([role({ role: "unknown", actionGroup: "a" })]))).toEqual([
      "unknown_cannot_group",
    ]);
    const start = TEXT.indexOf("verify it");
    expect(
      issueCodes(
        sample([
          role({
            role: "unknown",
            text: "x",
            restated: true,
            spans: [{ start, end: start + 3 }],
          }),
        ]),
      ),
    ).toEqual(["unknown_cannot_restate"]);
    expect(issueCodes(sample([role({ role: "constraints", actionGroup: "missing" })]))).toEqual([
      "dangling_action_group",
    ]);
  });

  test("rejects unknown fields, versions and missing inference as shape errors", () => {
    expect(issueCodes(sample([role({ confidence: 0.9 })]))).toEqual(["shape"]);
    expect(issueCodes(sample([role({ inference: "" })]))).toEqual(["shape"]);
    expect(issueCodes(sample([], { formatVersion: 2 }))).toEqual(["shape"]);
    expect(issueCodes(sample([], { spanUnit: "code-point" }))).toEqual(["shape"]);
  });

  test("protocol failures are experiment errors, not retrieval outcomes", () => {
    try {
      parseRoleSample(sample([role({ text: "wrong" })]), QUERY);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentError);
      expect((error as ExperimentError).code).toBe("protocol_invalid");
    }
  });

  test("canonical order and digest do not depend on input order", () => {
    const first = role({ actionGroup: "a" });
    const second = role({ role: "moment", inference: "also states timing" });
    const forward = parseRoleSample(sample([first, second]), QUERY);
    const reverse = parseRoleSample(sample([second, first]), QUERY);
    expect(reverse.digest).toBe(forward.digest);
    expect(reverse.sample).toEqual(forward.sample);
    const changed = parseRoleSample(
      sample([first, { ...second, inference: "different reasoning" }]),
      QUERY,
    );
    expect(changed.digest).not.toBe(forward.digest);
  });
});
