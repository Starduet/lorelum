import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FROZEN_CONTROL_INPUTS } from "./frozen-inputs";

const run = promisify(execFile);
const CLI = `${import.meta.dir}/control-cli.ts`;

describe("control-cli query identity", () => {
  test("a partial query identity exits non-zero before any run starts", async () => {
    const outcome = await run(
      "bun",
      [
        CLI,
        "replay",
        "--out",
        "x",
        "--queries",
        "q.json",
        "--store",
        "s",
        "--model",
        "m",
        "--native-manifest",
        "n",
        "--queries-sha256",
        "0".repeat(64),
      ],
      { cwd: import.meta.dir },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({
        code: error.code ?? 1,
        stderr: error.stderr ?? "",
      }),
    );
    expect(outcome.code).not.toBe(0);
  });

  test("the frozen G0 identity stays the default", () => {
    expect(FROZEN_CONTROL_INPUTS.caseCount).toBe(50);
    expect(FROZEN_CONTROL_INPUTS.suiteRevision).toBe("v2");
  });
});
