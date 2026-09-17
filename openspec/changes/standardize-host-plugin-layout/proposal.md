## Why

Lorelum 的 Codex Plugin 仍使用产品名作为 source directory，而 ZCode 接入在 PR #193 中同时出现产品 ID、宿主后缀目录和非原生 marketplace 路径，导致维护者无法一眼分辨哪些内容可共享、哪些是宿主专属。现在需要把这套边界写成短的开发规范，并让 Codex 与 ZCode 的源码落在同一、可预测的目录结构中。

本变更引入新的分发与维护者约定，同时实现 ZCode 接入；它不是通用 Plugin 平台，也不改变 Lorelum 的检索行为。

## What Changes

- 新增一页 maintainer-facing 插件开发规范，定义 `productId`、`hostKey`、source directory、宿主原生 manifest、marketplace registration、selector 和版本的责任边界；根 `AGENTS.md` 增加到该规范的索引。
- 将宿主 adapter 的 source root 统一为 `plugins/<hostKey>/lorelum/`：现有 Codex Plugin 移至 `plugins/codex/lorelum/`；将 PR #193 的 ZCode Plugin 落在 `plugins/zcode/lorelum/`。
- 保持用户侧的产品 ID `lorelum`、marketplace name `lorelum-plugins` 和 host-local selector `lorelum@lorelum-plugins` 不变；目录名承载宿主差异，不以 `lorelum-zcode` 作为公开 Plugin ID。
- 为 ZCode 使用官方的仓库根 `marketplace.json` 注册路径，并在 marketplace entry 写入与 `.zcode-plugin/plugin.json` 同步的版本；ZCode 的 manifest、Hook、`/lore` command 和 `lore hook zcode` ABI 保持 host-specific。
- 明确通用 `skills/lorelum/` 是 portable Skill core；host Plugin 内的 Skill 可以为 Catalog 注入等宿主条件做翻译，但须通过现有 guidance fixtures 保持检索行为一致。
- 重写中英文用户 Agent 文档，使它们只覆盖安装、使用、更新和可行动的故障排查；将 Bun、MCP、Hook envelope、Store、`packRoot`、CLI ABI 和 Agent prompt 细节保留给维护者或 Agent-facing reference，不再作为普通用户的阅读负担。

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `agent-integration`: 将 ZCode 纳入已支持的 host-specific Hook/Skill adapter，同时保持 CLI-first、Catalog 和 recovery 合同。
- `plugin-distribution`: 将单一 Codex source root 扩展为带 `hostKey` 的 adapter root，并定义 ZCode 的独立原生 marketplace 注册与稳定用户身份。

## Impact

- 受影响：PR #193 的 ZCode Plugin、Codex Plugin source path、两宿主 marketplace definition、插件测试、开发文档、站点 Agent/Codex/ZCode 用户页、`AGENTS.md` 与新增的维护者规范。
- 不改变：`lore` 查询/Store 语义、Codex/ZCode 的公开 Plugin ID 与 selector、Codex Hook ABI、CLI-first/no-local-MCP 边界。
- 不在本变更中新增 Claude Code、Cursor、OpenCode、WorkBuddy 或 Zed 的 artifact、registry、代码生成器或统一 manifest。
