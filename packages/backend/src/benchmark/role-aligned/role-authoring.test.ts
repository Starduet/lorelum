import { describe, expect, test } from "bun:test";

import { ExperimentError } from "./experiment-error";
import { authorRoleSamples } from "./role-authoring";

const QUERY = {
  id: "q",
  text: "The test failed after my change. Decide what is wrong before editing.",
};

describe("authorRoleSamples", () => {
  const authored = authorRoleSamples(QUERY, [
    { role: "intent", spans: ["Decide what is wrong"], restate: "Work out what is incorrect" },
    {
      role: "moment",
      spans: ["The test failed", "after my change"],
      restate: "my change made the test fail",
    },
    { role: "constraints", spans: ["before editing"], restate: "prior to any edit" },
  ]);

  test("resolves offsets from quoted fragments and keeps the primary text verbatim", () => {
    const moment = authored.primary.roles.find((annotation) => annotation.role === "moment")!;
    expect(moment.spans.map((span) => QUERY.text.slice(span.start, span.end))).toEqual([
      "The test failed",
      "after my change",
    ]);
    expect(moment.text).toBe("The test failed after my change");
    expect(moment.restated).toBe(false);
  });

  test("the restated set has the same roles and spans with different wording", () => {
    expect(authored.restated.roles.map((a) => [a.role, a.spans])).toEqual(
      authored.primary.roles.map((a) => [a.role, a.spans]),
    );
    for (const annotation of authored.restated.roles) expect(annotation.restated).toBe(true);
    expect(authored.restated.analysisVersion).not.toBe(authored.primary.analysisVersion);
  });

  test("a fragment that is not in the query, or is out of order, is rejected", () => {
    const attempt = (spans: string[]) => () =>
      authorRoleSamples(QUERY, [{ role: "intent", spans, restate: "x" }]);
    expect(attempt(["not present"])).toThrow(ExperimentError);
    expect(attempt(["after my change", "The test failed"])).toThrow(ExperimentError);
  });

  test("a restatement identical to the fragment is rejected", () => {
    expect(() =>
      authorRoleSamples(QUERY, [
        { role: "intent", spans: ["before editing"], restate: "before editing" },
      ]),
    ).toThrow(ExperimentError);
  });

  test("reports a fragment that occurs twice instead of silently picking one", () => {
    const repeated = { id: "r", text: "check it and check it again" };
    const result = authorRoleSamples(repeated, [
      { role: "intent", spans: ["check it"], restate: "verify it" },
    ]);
    expect(result.ambiguousSpans).toEqual(["check it"]);
    expect(result.primary.roles[0]!.spans).toEqual([{ start: 0, end: 8 }]);
  });
});
