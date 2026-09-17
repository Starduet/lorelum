## Why

当前 Codex Plugin 同时使用 `lorelum` 作为 marketplace 名和 Plugin ID。Codex 的缓存路径因此包含连续两层同名目录；在宿主以 root alias 加相对路径展示 Skill 时，Agent 容易把其中一层漏掉并误报缓存路径不一致。现有 Skill 提示可以降低误判，但不能消除公开分发层与可安装 Plugin 层没有区分的根源。

产品仍处于 alpha，适合在用户配置和安装文档尚未稳定前，建立清晰、可长期维护的两层命名。

## What Changes

- **BREAKING** 将 Codex marketplace 的公开名称从 `lorelum` 改为 `lorelum-plugins`；保持可安装 Plugin ID 和显示名为 `lorelum` / **Lorelum**。当前宿主 source root 由后续的 `standardize-host-plugin-layout` 变更定义为 `plugins/codex/lorelum/`。
- **BREAKING** 将公开安装和更新 selector 改为 `lorelum@lorelum-plugins`，并在用户文档中给出从旧 `lorelum@lorelum` source 的明确迁移步骤。
- 更新 Plugin marketplace metadata、分发合同、开发热更新说明、站点文档和测试，使分发 namespace 与 Plugin identity 分别可见且一致。
- 保持 Skill、Hook 和 `lore` CLI 的运行边界及现有检索语义不变；此变更不引入 MCP、Store 访问或新的检索路径。

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `plugin-distribution`: 将单一公开 Plugin identity 的要求改为明确、稳定的 marketplace namespace 与 Plugin ID，并定义 alpha 迁移后的唯一 selector。

## Impact

- 受影响：`.agents/plugins/marketplace.json`、Codex Plugin manifest 的分发测试、Codex 安装/更新/开发文档、站点中英文 Codex 安装页，以及当前用户的 marketplace 配置。
- 受影响的公开命令从 `codex plugin add lorelum@lorelum` 变为 `codex plugin add lorelum@lorelum-plugins`。
- 不受影响：Plugin 显示名、Hook ABI、`lore` CLI、Pack Store、semantic query 和本地 MCP 边界。

## Supersession note

本 change 只保留 marketplace namespace 与公开 selector 的迁移合同。后续 active change
`standardize-host-plugin-layout` 已接管宿主 source root 的命名与迁移；本 change 中任何
历史 `plugins/lorelum/` 路径不得再作为当前实现或分发合同使用。
