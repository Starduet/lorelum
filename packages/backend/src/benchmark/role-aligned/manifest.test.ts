import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "./digest";
import { expectExperimentError } from "./control-fixtures";
import { parseRunManifest, readCodeIdentity, verifyArtifact, type GitProbe } from "./manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lorelum-manifest-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "a", "utf8");
  await writeFile(join(root, "src", "b.ts"), "b", "utf8");
  return root;
}

const git: GitProbe = { head: async () => "c".repeat(40), dirty: async () => true };

describe("readCodeIdentity", () => {
  test("describes the working tree, not just HEAD", async () => {
    const root = await workspace();
    const before = await readCodeIdentity(root, ["src/b.ts", "src/a.ts", "src/a.ts"], git);
    expect(before.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(before.files[0]?.sha256).toBe(sha256Hex("a"));
    expect(before.listedFilesDirty).toBe(true);
    await writeFile(join(root, "src", "a.ts"), "changed", "utf8");
    const after = await readCodeIdentity(root, ["src/a.ts", "src/b.ts"], git);
    expect(after.commit).toBe(before.commit);
    expect(after.digest).not.toBe(before.digest);
  });

  test("an unreadable listed file is an experiment error", async () => {
    const root = await workspace();
    await expectExperimentError(readCodeIdentity(root, ["src/missing.ts"], git), "input_missing");
  });
});

describe("verifyArtifact", () => {
  test("returns matching bytes and refuses a missing or altered artifact", async () => {
    const root = await workspace();
    await writeFile(join(root, "artifact.json"), "{}", "utf8");
    const identity = { file: "artifact.json", sha256: sha256Hex("{}"), bytes: 2 };
    expect(Buffer.from(await verifyArtifact(root, identity)).toString("utf8")).toBe("{}");
    await writeFile(join(root, "artifact.json"), "{ }", "utf8");
    await expectExperimentError(verifyArtifact(root, identity), "input_corrupt");
    await expectExperimentError(
      verifyArtifact(root, { ...identity, file: "absent.json" }),
      "input_missing",
    );
  });
});

describe("parseRunManifest", () => {
  test("rejects structurally invalid manifests as corrupt input", () => {
    expect(() => parseRunManifest({})).toThrow();
    expect(() => parseRunManifest({ manifestVersion: 1, status: "pending" })).toThrow();
  });

  test("accepts a failed manifest that carries only its code identity and failure", () => {
    const parsed = parseRunManifest({
      manifestVersion: 1,
      status: "failed",
      experiment: { id: "x", condition: "control" },
      code: {
        commit: "d".repeat(40),
        listedFilesDirty: false,
        files: [{ path: "a.ts", sha256: sha256Hex("a") }],
        digest: sha256Hex("files"),
      },
      failure: { code: "input_mismatch", message: "queries differ" },
    });
    expect(parsed.status).toBe("failed");
  });
});
