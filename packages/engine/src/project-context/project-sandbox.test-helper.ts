import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/**
 * Project layer discovery walks every ancestor up to the filesystem root, so a
 * sandbox created under a tainted chain (for example a tmpdir under a home that
 * holds the developer Store at `~/.lorelum`) leaks real Store layers into the
 * snapshot. Sandboxes for tests that observe layer discovery must therefore be
 * created under a base whose ancestor chain contains no `.lorelum` layer.
 */

const repositoryRoot = resolve(import.meta.dir, "../../../..");

async function isProjectLayer(directory: string): Promise<boolean> {
  const marker = await lstat(join(directory, ".lorelum")).catch(() => undefined);
  return marker !== undefined && marker.isDirectory() && !marker.isSymbolicLink();
}

async function hasProjectLayerAncestor(directory: string): Promise<boolean> {
  const start = await realpath(directory).catch(() => undefined);
  if (start === undefined) return true;
  for (let current = start; ; current = dirname(current)) {
    // eslint-disable-next-line no-await-in-loop -- ancestor probing is ordered from the leaf upward.
    if (await isProjectLayer(current)) return true;
    if (current === parse(current).root) return false;
  }
}

let isolatedBase: Promise<string> | undefined;

function selectIsolatedBase(): Promise<string> {
  isolatedBase ??= (async () => {
    if (!(await hasProjectLayerAncestor(tmpdir()))) return tmpdir();
    const scratch = join(repositoryRoot, "node_modules", ".lorelum-test-sandbox");
    await mkdir(scratch, { recursive: true });
    if (!(await hasProjectLayerAncestor(scratch))) return scratch;
    throw new Error(
      "No sandbox base without a .lorelum project-layer ancestor; point TMPDIR (TEMP/TMP on Windows) at a clean directory.",
    );
  })();
  return isolatedBase;
}

export async function createIsolatedProjectSandbox(prefix: string): Promise<string> {
  return mkdtemp(join(await selectIsolatedBase(), prefix));
}
