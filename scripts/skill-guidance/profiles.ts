export interface GuidanceProfile {
  readonly description: string;
  readonly catalog: string;
  readonly readHints: string;
  readonly todo?: string;
}

const sharedCatalog =
  "Use a Pack Catalog already available in the task context. Its descriptions and stack scopes help identify potentially relevant Packs, but do not rule out other Packs. If no usable Catalog is available and the current decision needs new guidance discovery, run `lore pack list --details` once and reuse it. If you only need to read a known exact Practice ID, do not establish a Catalog solely for that read. Do not run the list just because the task started.";

const ompCatalog =
  "Use a Pack Catalog already available in the task context. Its descriptions and stack scopes help identify potentially relevant Packs, but do not rule out other Packs. Main receives the Catalog; task/eval children do not by default (`agent.subagentPackCatalog: false`). Do not run `lore pack list --details` merely because a child has no Catalog or bootstrap a Catalog automatically. If Main has no usable Catalog and needs new guidance discovery, run `lore pack list --details` once and reuse it. Independent Pack discovery is allowed when a material decision in a child's assigned task actually requires it; then list once and reuse the result. If you only need to read a known exact Practice ID, do not establish a Catalog solely for that read.";

const ompReadHints =
  "Read-Practice hints in an omp child come from successful gets by the originating Main session, including in nested task/eval children. They are possibly relevant metadata, not the full guidance or proof of adoption. Read a candidate in full before using it; your own reads belong to your session and are not automatically added to Main's candidates. Enabling `agent.subagentPackCatalog: true` adds only Pack routing metadata, never complete Pack or Practice bodies.";

const planningDescription =
  "When planning, note what to look up in Lorelum at the step that needs it; then read and apply the relevant Practice.";

const injectedCatalogDescription = `${planningDescription} Use the injected Pack Catalog to discover relevant guidance.`;

const commandDescription = `${injectedCatalogDescription} The /lore command is also available.`;

export const guidanceProfiles = {
  generic: {
    description: planningDescription,
    catalog: sharedCatalog,
    readHints: "",
  },
  claude: {
    description: injectedCatalogDescription,
    catalog: sharedCatalog,
    readHints: "",
  },
  codex: {
    description: injectedCatalogDescription,
    catalog: sharedCatalog,
    readHints: "",
  },
  cursor: {
    description: commandDescription,
    catalog: sharedCatalog,
    readHints: "",
  },
  omp: {
    description:
      "Find Practices before decisions. Read this Skill when recording lookup reminders in an omp todo.",
    catalog: ompCatalog,
    readHints: ompReadHints,
    todo: 'In omp, mark future lookups on the relevant todo step as `[query: specific question]` or `[get: exact.practice.id]`. Use the displayed reminder ID in a single Bash command, for example `lore query "specific question" --todo P1` or `lore get exact.practice.id --todo P2`. On success the lookup leaves the pending list. Do not reissue a settled ID as an unbound lookup. Write verification as a normal todo step with an observable outcome.',
  },
  workbuddy: {
    description: commandDescription,
    catalog: sharedCatalog,
    readHints: "",
  },
  zcode: {
    description: commandDescription,
    catalog: sharedCatalog,
    readHints: "",
  },
} as const satisfies Readonly<Record<string, GuidanceProfile>>;

export type GuidanceProfiles = Readonly<Record<string, GuidanceProfile>>;
