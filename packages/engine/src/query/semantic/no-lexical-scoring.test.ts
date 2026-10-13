import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The semantic path must decide on embedding cosine alone. A lexical score is
 * not a weaker ranking signal here, it is a wrong one: FTS5's production
 * tokenizer turns an unspaced CJK sentence into a single token, so every
 * substring query returns zero hits, and no tokenizer can match a paraphrase or
 * another language at all. This guard fails if the lexical machinery is
 * imported or called from the semantic path again.
 */
const LEXICAL_MODULE = /keyword|fts5|bm25/i;
const LEXICAL_SYMBOL =
  /\b(buildKeywordIndex|projectKeywordPractice|KeywordIndexUnavailableError)\b/;

async function productionSources(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionSources(path)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-helper.ts")) continue;
    files.push(path);
  }
  return files;
}

function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)) specifiers.push(match[1]!);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gmu))
    specifiers.push(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

const semanticRoot = import.meta.dir;
const artifactRoot = join(import.meta.dir, "..", "artifacts");
const artifactSources = ["semantic.ts", "semantic-progress.ts", "vector-cache.ts"].map((name) =>
  join(artifactRoot, name),
);

test("the semantic path never imports a lexical scorer", async () => {
  const paths = [...(await productionSources(semanticRoot)), ...artifactSources];
  // Guard against a silently empty scan if the tree is ever moved or renamed.
  expect(paths.length).toBeGreaterThan(12);

  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const specifier of importSpecifiers(source)) {
      expect(`${path} -> ${specifier}`).not.toMatch(LEXICAL_MODULE);
    }
  }
});

test("the semantic path never calls the keyword projection or index", async () => {
  const paths = [...(await productionSources(semanticRoot)), ...artifactSources];

  for (const path of paths) {
    const source = await readFile(path, "utf8");
    const offending = source
      .split("\n")
      .filter((line) => LEXICAL_SYMBOL.test(line))
      .join("\n");
    expect(`${path}\n${offending}`).toBe(`${path}\n`);
  }
});
