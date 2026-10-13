import { expect, test } from "bun:test";

import { projectSemanticQuery } from "./query-views";

test("drops the whole-sentence view and keeps independent clauses", () => {
  const views = projectSemanticQuery(
    "I am opening a PR that fixes a React cache bug; a reviewer will see it without our chat history, so make the context self-contained.",
  );

  expect(views.map((view) => view.text)).toEqual([
    "I am opening a PR that fixes a React cache bug",
    "a reviewer will see it without our chat history",
    "so make the context self-contained",
  ]);
  expect(views.map((view) => view.weight)).toEqual([1, 1, 1]);
  expect(views.map((view) => view.viewId)).toEqual(["clause:0000", "clause:0001", "clause:0002"]);
});

test("splits CJK clauses without a word tokenizer and keeps one view for an atomic query", () => {
  expect(
    projectSemanticQuery("检查缓存去重；保留请求隔离，确保每个用户只看到自己的数据。").map(
      (view) => view.text,
    ),
  ).toEqual(["检查缓存去重", "保留请求隔离", "确保每个用户只看到自己的数据"]);

  expect(projectSemanticQuery("去重").map((view) => view.text)).toEqual(["去重"]);
});
