# Lorelum for ZCode

This is the first-party ZCode integration for Lorelum. It brings relevant engineering Practices into ZCode when they can inform a task or decision, without loading every rule at once. Its progressive-disclosure flow is:

The current host integration contract is [agent-integration](../../../openspec/specs/agent-integration/spec.md); this README explains the ZCode-specific distribution and operating model.

1. A compact **Installed Pack Catalog** makes the locally available Knowledge Packs discoverable.
2. The Lorelum Skill uses that catalog as a relevance hint, not as the full engineering rules or a hard filter.
3. At a material task, decision, verification, recovery, or completion moment, ZCode uses one targeted natural-language semantic query before deciding retrieval is not worth attempting.
4. Before applying a Practice or claiming that work follows it, ZCode reads the full Practice.

The `/lore` command is the explicit entry point: it accepts an optional natural-language question and routes it through the Lorelum Skill.

The bundled runtime integration calls `lore hook zcode`, the versioned ZCode Hook ABI. It runs for supported `SessionStart` sources (`startup`, `resume`, `clear`, `compact`), so the Catalog is regenerated before ZCode continues after compaction. The CLI reads the Hook payload from stdin and writes the ZCode `hookSpecificOutput` envelope directly to stdout. The Hook uses ZCode's native `process` form (`lore` with `hook zcode` arguments), so it does not depend on a shell, Git Bash, or a platform wrapper.

The integration requests Pack-level discovery data, including each current Pack root, but not Practice bodies or resource content. It does not install or update Packs, or automatically run `lore query` or `lore get`; the Skill makes those task-specific decisions and opening the LocalStore still follows its normal lifecycle. When the Hook ABI runs but cannot process its input or read the Store, it writes a diagnostic to stderr and returns a non-blocking response without additional context.

## Integration scope

This Plugin is deliberately CLI-first: it uses the compiled `lore` executable together with the Lorelum Skill, the `/lore` command, and the ZCode SessionStart Hook. It does not bundle, configure, or call a local MCP server, and a local MCP wrapper is not a planned Plugin optimization. MCP is reserved for a separately approved future platform remote-retrieval service.

## Retrieval availability

`lore query` defaults to local semantic retrieval. A ready semantic query is the normal path; expected latency alone is not a reason to skip it, and this documentation makes no fixed-latency promise. The normal Skill path starts by issuing its targeted natural-language query; it does not preflight Backend, model, index, or status commands. A `data.state: "preparing"` response, an unavailable model, or an unavailable semantic index is a lifecycle state or actionable error, not evidence that no relevant Practice exists. Only after such a response does the caller follow the documented model or index recovery path and retry the same query. Use `--mode keyword` only for an intentional offline lookup or semantic-runtime diagnosis, and identify those results as keyword retrieval.

## Installation

This Plugin is a ZCode adapter. The `lore` command must be available on the `PATH` inherited by ZCode; the Plugin does not embed, build, or update the CLI. Bun is only required for maintainers running the source and test workflows.

Install from the ZCode client: open **Settings → Plugin Management → Discover**, add the Lorelum repository (`lorelum/lorelum` on GitHub, or a local checkout directory) as a marketplace with the **`+`** button, then install **Lorelum** (`lorelum`) from `lorelum-plugins`. The installed identity is `lorelum@lorelum-plugins`, matching the Codex plugin identity.

Plugin Hooks are activated by the installed Plugin; no separate `hooks.enabled` setting is required for this integration. See the [ZCode installation guide](https://lorelum.com/en/docs/zcode) for details and [the development guide](../../../docs/development/plugins.md) for a checkout-backed development install.

## Local validation

From the repository root:

```sh
bun test plugins/zcode/lorelum/scripts
```

The CLI and Store integration is connected end to end: the Hook runs `lore hook zcode` against the LocalStore and renders the returned summaries. To smoke-check current source, install Packs into an isolated Store root, then pipe a Hook event through the source entrypoint. This source-only check requires Bun; an installed Plugin does not.

```sh
printf '%s\n' '{"hook_event_name":"SessionStart"}' | bun packages/cli/src/main.ts hook zcode --store-root /tmp/lore-e2e-store
```
