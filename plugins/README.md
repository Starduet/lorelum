# Lorelum plugins

Each direct child of this directory is an independently installable Plugin artifact for one host. It contains the host-specific lifecycle integration, context rendering, Skills, and distribution metadata; it is not a shared Engine layer.

`lorelum/` is the Codex Plugin, published as `lorelum@lorelum-plugins` (Codex marketplace: repo-root `.agents/plugins/marketplace.json`) and shown as **Lorelum**. `lorelum-zcode/` is the ZCode Plugin, published as `lorelum@lorelum-plugins` (ZCode marketplace: repo-root `.claude-plugin/marketplace.json`); it also provides the `/lore` command. Both call the public `lore` CLI for Pack metadata. They must not import Engine packages, read LocalStore files directly, or reproduce retrieval and ranking behavior.

## Current integration boundary

Lorelum is CLI-first. Host Plugins use the compiled `lore` CLI plus host-native Skills and Hooks; they do not start, bundle, configure, or call a local MCP server. Do not add a local MCP convenience layer, stdio server, MCP tools, or MCP-backed UI while developing a Plugin. MCP is reserved for a separately approved future platform remote-retrieval service, not a local performance or integration optimization. See [the active scope decision](../openspec/specs/agent-integration/spec.md).

Do not add placeholder directories for future agents. When another host needs a real integration, define its independent install and trust model first (including the marketplace file its host actually probes); only then add its artifact here or choose a host-required marketplace layout. A future `learn` capability remains inside the relevant host Plugin unless it later requires independent installation, permissions, trust, audience, or release cadence.
