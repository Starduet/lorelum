## 1. Establish the implementation baseline

- [x] 1.1 Reconcile this change with PR #193 (`c4c4384`) and the unfinished Codex marketplace-identity change; verify the target worktree contains one reviewed ZCode Hook implementation, preserves the existing Codex public selector, and has no competing source-path contract.
- [x] 1.2 Add regression fixtures that describe the canonical `plugins/<hostKey>/lorelum/` layout and host-local selector semantics; verify the fixture rejects a host-suffixed public Plugin ID, a marketplace entry without a matching manifest version, and a registration pointing at another host's artifact.

## 2. Refactor host artifacts and registrations

- [x] 2.1 Move the Codex artifact and its source-only tests from `plugins/lorelum/` to `plugins/codex/lorelum/`; update `.agents/plugins/marketplace.json`, test-relative paths, cachebuster/validator commands, and documentation references; verify Codex still resolves exactly `lorelum@lorelum-plugins` with manifest ID `lorelum` and display name **Lorelum**.
- [x] 2.2 Add the reviewed ZCode artifact at `plugins/zcode/lorelum/`, preserving its `.zcode-plugin` manifest ID `lorelum`, native Hook wrapper, `/lore` command, Skill, and `lore hook zcode` ABI; verify ZCode-specific configuration and CLI Hook tests pass without changing Codex Hook behavior.
- [x] 2.3 Create the canonical ZCode root `marketplace.json` with source `./plugins/zcode/lorelum` and a version matching its manifest; remove the noncanonical `.claude-plugin/marketplace.json` registration; verify the marketplace test fails on a missing or mismatched version and Codex registration remains separate.

## 3. Publish the maintainer convention

- [x] 3.1 Write `docs/development/plugin-conventions.md` with the identity/path matrix, portable-Skill versus native-overlay boundary, current Codex/ZCode examples, new-host admission checklist, version rule, and explicit non-goals; verify all documented relative paths and host registration filenames exist.
- [x] 3.2 Add a `plugins` ownership/index row to root `AGENTS.md` that points to the convention and relevant current specs; link the convention from `docs/development/README.md`, and revise `plugins/README.md` and `docs/development/plugins.md` so they navigate to rules rather than duplicate them.
- [x] 3.3 Rewrite the English and Chinese `agent-setup`, Codex, and ZCode user guides around install, first use, update, and actionable troubleshooting; remove Bun, MCP, Store, Hook envelope, Catalog-field, `packRoot`, and CLI-ABI explanations from their normal reading path, while keeping each host's concrete prerequisite and one verification action.
- [x] 3.4 Keep `agents.mdx` and `agents.zh.mdx` as Agent-facing CLI/recovery reference rather than general-user onboarding; remove it from the normal installation path and verify its technical material is not duplicated in the user guides.

## 4. Verify migration and delivery readiness

- [x] 4.1 Run focused Codex/ZCode artifact, CLI Hook, Skill-guidance, typecheck, documentation/link, and layout-fixture checks; manually review both locales as a new user to verify the main flow answers only “how to install, use, update, and recover,” and report environment setup failures separately from contract failures.
- [ ] 4.2 Validate a clean checkout-backed marketplace install for Codex and ZCode, including ZCode Hooks enablement, a new-task Catalog injection, and a ZCode update-version comparison; verify a rollback restores only source paths/registration files without changing a user's selector.
  - 2026-09-17 部分验证：Codex 已从当前 checkout 以 `lorelum@lorelum-plugins` 成功安装并启用；新会话完成 `SessionStart`，确认同时获得 Lorelum Skill 与 Installed Pack Catalog；测试结束后 Git marketplace、已安装 Plugin 和配置文件均恢复至备份前状态。ZCode client、Hooks enablement 和真实 update-version comparison 仍待可用的 ZCode 环境验证。
- [x] 4.3 Run `openspec validate standardize-host-plugin-layout --strict` and `git diff --check`; inspect the complete staged diff and run the required secret scan before any future commit or PR operation.
