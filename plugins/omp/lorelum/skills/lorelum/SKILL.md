---
name: lorelum
description: Find Practices before decisions that need guidance. When creating a todo plan, record future lookups as [practice: specific question] in the relevant step.
---
<!-- Generated from scripts/skill-guidance/content/skill.md.tmpl and profiles.ts. Run bun run skills:generate to regenerate. -->

# Lorelum

## Find and read guidance

Use a Pack Catalog already available in the task context. Its descriptions and stack scopes help identify potentially relevant Packs, but do not rule out other Packs. Main receives the Catalog; task/eval children do not by default (`agent.subagentPackCatalog: false`). Do not run `lore pack list --details` merely because a child has no Catalog or bootstrap a Catalog automatically. If Main has no usable Catalog and needs new guidance discovery, run `lore pack list --details` once and reuse it. Independent Pack discovery is allowed when a material decision in a child's assigned task actually requires it; then list once and reuse the result. If you only need to read a known exact Practice ID, do not establish a Catalog solely for that read.

For a material engineering decision, describe the observed situation, the decision you face, and the constraints or failure consequences that matter. For example:

```sh
lore query "A payment may commit before a timeout; clients retry. How should we prevent duplicate charges and test recovery?"
```

Read default text directly, use `--verbose` for all result fields as text, and use `--json` when a program needs to parse the result.

Use `lore query` as needed and read the full Practice with `lore get <practice-id>` before applying it within the user's authorization; preserve existing tasks and statuses, and do not create or reset a plan just for Lorelum.

Read-Practice hints in an omp child come from successful gets by the originating Main session, including in nested task/eval children. They are possibly relevant metadata, not the full guidance or proof of adoption. Read a candidate in full before using it; your own reads belong to your session and are not automatically added to Main's candidates. Enabling `agent.subagentPackCatalog: true` adds only Pack routing metadata, never complete Pack or Practice bodies.

## Recover a query or diagnose a failure

Run the default semantic query before checking Backend, model, or index status. If it returns a preparation state, follow [semantic query recovery](references/semantic-query-recovery.md) and retry the same query when ready. Do not silently switch to keyword; use `--mode keyword` only for an intentional offline lookup or semantic-runtime diagnosis.

If a Lorelum invocation fails and blocks the task or the user asks to diagnose that invocation, inspect its original `diagnostics.traceId` first when available, then follow the recovery reference. If a non-query failure has no trace, state that limit and follow its visible error instead; do not manufacture a trace. Retry the same Lorelum command when its cause is resolved:

```sh
lore logs --trace-id <traceId>
```

For a project test or other non-Lorelum failure, diagnose that failure in its own task context and assess the relevant guidance gap; do not assume it has a Lorelum trace.

## Use linked Pack resources

Resolve the path after a Practice's `resource:` link against the `packRoot` of its corresponding Store source in `lore get`. If multiple sources provide the Practice, use the task's Pack context to identify the source; do not guess or mix their roots. A ProjectContext `project-layer-N` is provenance, not a filesystem path.

For explicit Pack browsing, get its current root with `lore pack list <pack-name>`. After a Pack mutation, refresh the locator with `lore get` or the named `pack list`, as appropriate. Copy Pack assets into the task workspace before editing them; run Pack scripts only when the task authorizes it and their purpose and inputs are clear.

## Keep Backend available for a long task

If a multi-step task needs an already-running Lorelum Backend to remain available between calls, acquire a lease before that work, renew it before expiry, and release it when the task completes or is cancelled. A single query does not need a lease:

```sh
lore backend lease acquire
lore backend lease renew <lease-id>
lore backend lease release <lease-id>
```
