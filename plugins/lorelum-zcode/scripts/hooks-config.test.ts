import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface HookConfiguration {
  readonly hooks: {
    readonly SessionStart?: readonly {
      readonly matcher: string;
      readonly hooks: readonly {
        readonly type?: string;
        readonly command?: string;
        readonly async?: boolean;
        readonly timeout?: number;
        readonly commandWindows?: string;
        readonly additionalContextLimit?: number;
      }[];
    }[];
    readonly PostCompact?: unknown;
  };
}

async function readHookConfiguration(): Promise<HookConfiguration> {
  return JSON.parse(
    await readFile(join(import.meta.dir, "../hooks/hooks.json"), "utf8"),
  ) as HookConfiguration;
}

test("restores the Pack Catalog through SessionStart via the cross-platform wrapper", async () => {
  const configuration = await readHookConfiguration();

  expect(configuration.hooks.SessionStart).toEqual([
    {
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
          async: false,
          timeout: 10,
        },
      ],
    },
  ]);
  expect(configuration.hooks.PostCompact).toBeUndefined();
  const hook = configuration.hooks.SessionStart?.[0]?.hooks[0];
  // ZCode does not support the Codex-only commandWindows/additionalContextLimit
  // fields; the catalog budget is enforced by the CLI renderer instead.
  expect(hook?.commandWindows).toBeUndefined();
  expect(hook?.additionalContextLimit).toBeUndefined();
});

test("hook scripts invoke only the released lore CLI and keep a continue fallback", async () => {
  const [sessionStart, runHook] = await Promise.all([
    readFile(join(import.meta.dir, "../hooks/session-start"), "utf8"),
    readFile(join(import.meta.dir, "../hooks/run-hook.cmd"), "utf8"),
  ]);

  expect(sessionStart).toContain("lore hook zcode");
  expect(sessionStart).toContain("'{\"continue\":true}'");
  expect(sessionStart).not.toContain("bun ");
  expect(sessionStart).not.toContain("@lorelum/");
  expect(runHook).toContain("session-start");
  expect(runHook).not.toContain("lore ");
  expect(runHook).not.toContain("@lorelum/");
});

test.skipIf(process.platform === "win32")(
  "forwards the Hook payload to lore hook zcode without a Bun runtime",
  async () => {
    const configuration = await readHookConfiguration();
    const command = configuration.hooks.SessionStart?.[0]?.hooks[0]?.command;
    if (command === undefined) throw new Error("Missing ZCode Hook command.");

    const directory = await mkdtemp(join(tmpdir(), "lorelum-zcode-hook-cli-"));
    const lore = join(directory, "lore");
    const payload = '{"hook_event_name":"SessionStart"}';
    await writeFile(
      lore,
      [
        "#!/bin/sh",
        'input="$(cat)"',
        `if [ "$input" != '${payload}' ]; then exit 2; fi`,
        'printf \'{"hookSpecificOutput":{"hookEventName":"SessionStart"}}\\n\'',
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(lore, 0o755);

    try {
      const child = Bun.spawn(["sh", "-c", command], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          CLAUDE_PLUGIN_ROOT: join(import.meta.dir, ".."),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(payload);
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe('{"hookSpecificOutput":{"hookEventName":"SessionStart"}}\n');
      expect(stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "uses a single continue envelope when an older CLI rejects the Hook ABI",
  async () => {
    const configuration = await readHookConfiguration();
    const command = configuration.hooks.SessionStart?.[0]?.hooks[0]?.command;
    if (command === undefined) throw new Error("Missing ZCode Hook command.");

    const directory = await mkdtemp(join(tmpdir(), "lorelum-zcode-old-cli-"));
    const oldLore = join(directory, "lore");
    await writeFile(oldLore, "#!/bin/sh\nprintf '{\"ok\":false}\\n'\nexit 2\n", "utf8");
    await chmod(oldLore, 0o755);

    try {
      const child = Bun.spawn(["sh", "-c", command], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          CLAUDE_PLUGIN_ROOT: join(import.meta.dir, ".."),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe('{"continue":true}\n');
      expect(stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
