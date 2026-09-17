# plugin-distribution delta — add-zcode-plugin-hook

## MODIFIED Requirements

### Requirement: Single public Plugin identity

每个受支持的宿主 SHALL 恰好有一个可安装的 Lorelum Plugin 身份，且 marketplace namespace、Plugin ID、source root 与 selector MUST 各自指向该宿主唯一的公开分发来源；它们不得通过同名约束被混为一个身份。

Codex 侧：公开 Codex marketplace SHALL 使用名称 `lorelum-plugins`（`.agents/plugins/marketplace.json`），并且 SHALL 只暴露一个 ID 为 `lorelum` 的 Lorelum Codex Plugin。该 Plugin SHALL 保持显示名 **Lorelum**、源目录 `plugins/lorelum/` 和公开 selector `lorelum@lorelum-plugins`。alpha 迁移后，公开文档和开发流程 MUST 只使用 `lorelum-plugins`。用户在安装新版本前 MUST 移除旧 `lorelum` marketplace source；公开分发不得同时声明旧 selector `lorelum@lorelum` 作为兼容别名，以免同一 Plugin ID 出现两个可选 source。

ZCode 侧：仓库根 `.claude-plugin/marketplace.json`（ZCode 添加 GitHub 仓库或本地目录时探测的 marketplace 路径）SHALL 使用名称 `lorelum-plugins`，并且 SHALL 只暴露一个 ID 为 `lorelum` 的 Lorelum ZCode Plugin（与 Codex 插件同名同 selector 规范，宿主差异由源目录与 marketplace 文件承载），源目录 `plugins/lorelum-zcode/`，公开 selector `lorelum@lorelum-plugins`。两个宿主的 marketplace 文件 MUST 保持独立，MUST 不在其中一个文件中声明另一个宿主的 Plugin 或修改另一宿主的分发来源。

#### Scenario: Marketplace installation

- **WHEN** 用户按公开安装文档配置 Lorelum Codex integration
- **THEN** Codex SHALL 从 `lorelum-plugins` marketplace 安装 `lorelum` Plugin，且已安装 selector 为 `lorelum@lorelum-plugins`

#### Scenario: Alpha user migrates from the legacy selector

- **WHEN** 用户的 Codex 配置仍含有 legacy `lorelum` marketplace 或 `lorelum@lorelum` Plugin
- **THEN** 迁移文档 SHALL 要求先移除该 legacy source，再添加 `lorelum-plugins` 并安装 `lorelum@lorelum-plugins`，使迁移完成后只有一个 Lorelum marketplace source

#### Scenario: Distribution keeps the Plugin identity stable

- **WHEN** Codex 从 `lorelum-plugins` 解析 Lorelum Plugin
- **THEN** marketplace metadata SHALL 解析到 `plugins/lorelum/`，Plugin manifest ID SHALL 为 `lorelum`，且用户可见显示名 SHALL 为 **Lorelum**

#### Scenario: ZCode marketplace installation

- **WHEN** 用户在 ZCode 中添加 Lorelum 仓库或本地目录作为 marketplace，并按公开安装文档安装 ZCode Plugin
- **THEN** ZCode SHALL 从 `.claude-plugin/marketplace.json` 定义的 `lorelum-plugins` 安装 `lorelum` Plugin，且已安装 selector 为 `lorelum@lorelum-plugins`

#### Scenario: Distribution keeps the ZCode Plugin identity stable

- **WHEN** ZCode 从 `lorelum-plugins` 解析 Lorelum Plugin
- **THEN** marketplace metadata SHALL 解析到 `plugins/lorelum-zcode/`，Plugin manifest ID SHALL 为 `lorelum`，且 Codex 侧分发来源 MUST 不因 ZCode 支持而改变
