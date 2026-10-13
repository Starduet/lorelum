import { describe, expect, test } from "bun:test";

import { sha256Hex } from "./digest";
import {
  parsePilotLabel,
  PilotLabelError,
  summarizeTopK,
  type PilotLabelIssueCode,
} from "./pilot-labels";

const QUERY = { id: "p-1", text: "Verify the reviewer finding before editing." };
const CORPUS = new Map([
  ["a", sha256Hex("a-content")],
  ["b", sha256Hex("b-content")],
  ["c", sha256Hex("c-content")],
  ["d", sha256Hex("d-content")],
  ["e", sha256Hex("e-content")],
]);

function item(practiceId: string, cls: string, extra: Record<string, unknown> = {}) {
  return {
    practiceId,
    contentDigest: CORPUS.get(practiceId) ?? sha256Hex("unknown"),
    class: cls,
    rationale: "reviewed against the canonical text",
    ...extra,
  };
}

function label(items: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    queryId: QUERY.id,
    queryDigest: sha256Hex(QUERY.text),
    review: { reviewers: 2, blindToSystem: true, blindToRanking: true },
    noRelevantTarget: false,
    items,
    ...overrides,
  };
}

function codes(raw: unknown): PilotLabelIssueCode[] {
  try {
    parsePilotLabel(raw, QUERY, CORPUS);
  } catch (error) {
    if (error instanceof PilotLabelError) return error.issues.map((issue) => issue.code);
    throw error;
  }
  return [];
}

describe("parsePilotLabel", () => {
  test("accepts required cores, sufficient alternatives, supplements and unlabelled gaps", () => {
    expect(
      codes(
        label([
          item("a", "required-core"),
          item("b", "sufficient-alternative"),
          item("c", "prerequisite-or-supplement"),
        ]),
      ),
    ).toEqual([]);
  });

  test("a query with no relevant target must say so explicitly", () => {
    expect(codes(label([item("a", "forbidden")], { noRelevantTarget: true }))).toEqual([]);
    expect(codes(label([item("a", "forbidden")]))).toEqual(["target_declaration"]);
    expect(codes(label([item("a", "required-core")], { noRelevantTarget: true }))).toEqual([
      "target_declaration",
    ]);
    expect(codes(label([item("a", "undetermined")]))).toEqual(["target_declaration"]);
  });

  test("a Practice has one class and must exist with the reviewed content", () => {
    expect(codes(label([item("a", "required-core"), item("a", "forbidden")]))).toEqual([
      "duplicate_practice",
    ]);
    expect(codes(label([item("zzz", "required-core")]))).toEqual(["unknown_practice"]);
    expect(
      codes(label([{ ...item("a", "required-core"), contentDigest: sha256Hex("edited") }])),
    ).toEqual(["content_digest_mismatch"]);
  });

  test("a review split stays undetermined and needs two reviewers", () => {
    const split = {
      classes: ["required-core", "irrelevant"],
      note: "reviewers read the stage differently",
    };
    expect(
      codes(
        label([item("a", "required-core"), item("b", "undetermined", { disagreement: split })]),
      ),
    ).toEqual([]);
    expect(
      codes(label([item("a", "required-core"), item("b", "irrelevant", { disagreement: split })])),
    ).toEqual(["disagreement_class"]);
    expect(
      codes(
        label([item("a", "required-core"), item("b", "undetermined", { disagreement: split })], {
          review: { reviewers: 1, blindToSystem: true, blindToRanking: true, disclosure: "solo" },
        }),
      ),
    ).toEqual(["disagreement_needs_reviewers"]);
  });

  test("a single-reviewer or non-blind review must disclose its dependence risk", () => {
    const solo = { reviewers: 1, blindToSystem: true, blindToRanking: true };
    expect(codes(label([item("a", "required-core")], { review: solo }))).toEqual([
      "disclosure_required",
    ]);
    expect(
      codes(
        label([item("a", "required-core")], {
          review: { ...solo, disclosure: "the annotator also wrote the queries" },
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        label([item("a", "required-core")], {
          review: { reviewers: 2, blindToSystem: true, blindToRanking: false },
        }),
      ),
    ).toEqual(["disclosure_required"]);
  });

  test("rejects another query, an altered query, and unknown fields", () => {
    expect(codes(label([item("a", "required-core")], { queryId: "x" }))).toEqual([
      "query_id_mismatch",
    ]);
    expect(
      codes(label([item("a", "required-core")], { queryDigest: sha256Hex("changed") })),
    ).toEqual(["query_digest_mismatch"]);
    expect(codes(label([item("a", "required-core", { score: 1 })]))).toEqual(["shape"]);
    expect(codes(label([item("a", "maybe")]))).toEqual(["shape"]);
  });
});

describe("summarizeTopK", () => {
  const parsed = parsePilotLabel(
    label([
      item("a", "required-core"),
      item("b", "sufficient-alternative"),
      item("c", "forbidden"),
      item("d", "undetermined"),
    ]),
    QUERY,
    CORPUS,
  );

  test("counts each class in the top K and keeps unlabelled Practices apart", () => {
    const summary = summarizeTopK(parsed, ["x", "c", "a", "y", "d", "b"], 5);
    expect(summary.classCounts).toMatchObject({
      "required-core": 1,
      forbidden: 1,
      undetermined: 1,
      unlabelled: 2,
      "sufficient-alternative": 0,
    });
    expect(summary.anyHelp).toBe(true);
    expect(summary.fullyServed).toBe(true);
    expect(summary.hasForbidden).toBe(true);
    expect(summary.success).toBe(false);
  });

  test("K applies to the ranking only after the ranking is complete", () => {
    expect(summarizeTopK(parsed, ["x", "y", "a"], 2).anyHelp).toBe(false);
    expect(summarizeTopK(parsed, ["x", "y", "a"], 3).anyHelp).toBe(true);
  });

  test("an unlabelled Practice is never counted as irrelevant or forbidden", () => {
    const summary = summarizeTopK(parsed, ["x", "y"], 5);
    expect(summary.classCounts.irrelevant).toBe(0);
    expect(summary.hasForbidden).toBe(false);
    expect(summary.classCounts.unlabelled).toBe(2);
  });

  test("one of several required-core Practices helps but does not fully serve the task", () => {
    const multi = parsePilotLabel(
      label([item("a", "required-core"), item("e", "required-core"), item("c", "forbidden")]),
      QUERY,
      CORPUS,
    );
    const partial = summarizeTopK(multi, ["a", "x", "y"], 5);
    expect(partial.anyHelp).toBe(true);
    expect(partial.fullyServed).toBe(false);
    expect(partial.success).toBe(false);
    const complete = summarizeTopK(multi, ["a", "x", "e"], 5);
    expect(complete.fullyServed).toBe(true);
    expect(complete.success).toBe(true);
    expect(summarizeTopK(multi, ["a", "c", "e"], 5).success).toBe(false);
  });

  test("a sufficient alternative alone fully serves even when a required-core is absent", () => {
    const mixed = parsePilotLabel(
      label([
        item("a", "required-core"),
        item("e", "required-core"),
        item("b", "sufficient-alternative"),
      ]),
      QUERY,
      CORPUS,
    );
    expect(summarizeTopK(mixed, ["b"], 5).fullyServed).toBe(true);
    expect(summarizeTopK(mixed, ["a"], 5).fullyServed).toBe(false);
  });
});
