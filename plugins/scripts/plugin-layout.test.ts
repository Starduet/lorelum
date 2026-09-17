import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const productId = "lorelum";

interface NativeManifest {
  readonly name: string;
  readonly version: string;
}

interface CodexMarketplace {
  readonly name: string;
  readonly plugins: readonly {
    readonly name: string;
    readonly source: { readonly path: string };
  }[];
}

interface ZCodeMarketplace {
  readonly name: string;
  readonly plugins: readonly {
    readonly name: string;
    readonly source: string;
    readonly version?: string;
  }[];
}

function assertHostPluginIdentity(input: {
  readonly hostKey: string;
  readonly manifestName: string;
  readonly source: string;
}): void {
  if (!/^[a-z][a-z0-9-]*$/.test(input.hostKey)) {
    throw new Error(`Invalid host key: ${input.hostKey}`);
  }
  if (input.manifestName !== productId) {
    throw new Error(`Plugin ID must remain ${productId}.`);
  }
  const expectedSource = `./plugins/${input.hostKey}/${productId}`;
  if (input.source !== expectedSource) {
    throw new Error(`Expected ${expectedSource}, received ${input.source}.`);
  }
}

function assertZCodeMarketplaceVersion(
  marketplaceVersion: string | undefined,
  manifestVersion: string,
): void {
  if (marketplaceVersion === undefined || marketplaceVersion !== manifestVersion) {
    throw new Error("ZCode marketplace version must match the Plugin manifest version.");
  }
}

test("host adapters use a stable product ID and host-specific source roots", async () => {
  const root = join(import.meta.dir, "../..");
  const [codexManifest, zcodeManifest, codexMarketplace, zcodeMarketplace] = await Promise.all([
    readFile(join(root, "plugins/codex/lorelum/.codex-plugin/plugin.json"), "utf8").then(
      (content) => JSON.parse(content) as NativeManifest,
    ),
    readFile(join(root, "plugins/zcode/lorelum/.zcode-plugin/plugin.json"), "utf8").then(
      (content) => JSON.parse(content) as NativeManifest,
    ),
    readFile(join(root, ".agents/plugins/marketplace.json"), "utf8").then(
      (content) => JSON.parse(content) as CodexMarketplace,
    ),
    readFile(join(root, "marketplace.json"), "utf8").then(
      (content) => JSON.parse(content) as ZCodeMarketplace,
    ),
  ]);

  expect(codexMarketplace.name).toBe("lorelum-plugins");
  expect(zcodeMarketplace.name).toBe("lorelum-plugins");
  assertHostPluginIdentity({
    hostKey: "codex",
    manifestName: codexManifest.name,
    source: codexMarketplace.plugins[0]?.source.path ?? "",
  });
  assertHostPluginIdentity({
    hostKey: "zcode",
    manifestName: zcodeManifest.name,
    source: zcodeMarketplace.plugins[0]?.source ?? "",
  });
  assertZCodeMarketplaceVersion(zcodeMarketplace.plugins[0]?.version, zcodeManifest.version);
  await expect(access(join(root, ".claude-plugin/marketplace.json"))).rejects.toThrow();
});

test("layout validation rejects public host suffixes, cross-host sources, and version drift", () => {
  expect(() =>
    assertHostPluginIdentity({
      hostKey: "zcode",
      manifestName: "lorelum-zcode",
      source: "./plugins/zcode/lorelum",
    }),
  ).toThrow("Plugin ID must remain lorelum.");
  expect(() =>
    assertHostPluginIdentity({
      hostKey: "zcode",
      manifestName: "lorelum",
      source: "./plugins/codex/lorelum",
    }),
  ).toThrow("Expected ./plugins/zcode/lorelum");
  expect(() => assertZCodeMarketplaceVersion(undefined, "0.1.0-alpha.2")).toThrow(
    "ZCode marketplace version",
  );
  expect(() => assertZCodeMarketplaceVersion("0.1.0-alpha.1", "0.1.0-alpha.2")).toThrow(
    "ZCode marketplace version",
  );
});
