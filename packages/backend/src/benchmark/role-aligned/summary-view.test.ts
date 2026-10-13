import { describe, expect, test } from "bun:test";

import { ExperimentError } from "./experiment-error";
import { sectionText, summaryTexts } from "./summary-view";

const BODY = [
  "## When to apply",
  "Apply when A happens.",
  "",
  "### Detail",
  "Still part of when to apply.",
  "",
  "## Guidance",
  "1. Do the thing.",
  "",
  "## Why",
  "Because B.",
  "",
  "## Example",
  "Code here.",
].join("\n");

describe("sectionText", () => {
  test("keeps deeper-heading content, drops the heading line, stops at the next level-2 heading", () => {
    expect(sectionText(BODY, "When to apply")).toBe(
      "Apply when A happens.\n\nStill part of when to apply.",
    );
  });

  test("an absent section is empty", () => {
    expect(sectionText(BODY, "Exceptions and boundaries")).toBe("");
  });
});

describe("summaryTexts", () => {
  test("copies title, applies_when and the two sections verbatim, in that order", () => {
    const [text] = summaryTexts({ title: "T", applies_when: "W", body: BODY });
    expect(text).toBe(
      "T\n\nW\n\nApply when A happens.\n\nStill part of when to apply.\n\nBecause B.",
    );
  });

  test("guidance and example never enter the view", () => {
    const joined = summaryTexts({ title: "T", applies_when: "W", body: BODY }).join("\n");
    expect(joined).not.toContain("Do the thing");
    expect(joined).not.toContain("Code here");
  });

  test("a Practice without the sections still has a view from its title and applies_when", () => {
    expect(summaryTexts({ title: "T", applies_when: "W" })).toEqual(["T\n\nW"]);
  });

  test("a block over the token budget is a run failure, not a truncation", () => {
    const long = "word ".repeat(2000);
    expect(() => summaryTexts({ title: "T", applies_when: long })).toThrow(ExperimentError);
  });
});
