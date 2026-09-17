## MODIFIED Requirements

### Requirement: Single public Plugin identity
公开 Codex marketplace SHALL 使用名称 `lorelum-plugins`，并且 SHALL 只暴露一个 ID 为 `lorelum` 的 Lorelum Codex Plugin。该 Plugin SHALL 保持显示名 **Lorelum**、源目录 `plugins/codex/lorelum/` 和公开 selector `lorelum@lorelum-plugins`。marketplace namespace、Plugin ID、source root 和 selector MUST 各自指向这一份唯一的公开分发来源；它们不得通过同名约束被混为一个身份。

alpha 迁移后，公开文档和开发流程 MUST 只使用 `lorelum-plugins`。用户在安装新版本前 MUST 移除旧 `lorelum` marketplace source；公开分发不得同时声明旧 selector `lorelum@lorelum` 作为兼容别名，以免同一 Plugin ID 出现两个可选 source。

#### Scenario: Marketplace installation
- **WHEN** 用户按公开安装文档配置 Lorelum Codex integration
- **THEN** Codex SHALL 从 `lorelum-plugins` marketplace 安装 `lorelum` Plugin，且已安装 selector 为 `lorelum@lorelum-plugins`

#### Scenario: Alpha user migrates from the legacy selector
- **WHEN** 用户的 Codex 配置仍含有 legacy `lorelum` marketplace 或 `lorelum@lorelum` Plugin
- **THEN** 迁移文档 SHALL 要求先移除该 legacy source，再添加 `lorelum-plugins` 并安装 `lorelum@lorelum-plugins`，使迁移完成后只有一个 Lorelum marketplace source

#### Scenario: Distribution keeps the Plugin identity stable
- **WHEN** Codex 从 `lorelum-plugins` 解析 Lorelum Plugin
- **THEN** marketplace metadata SHALL 解析到 `plugins/codex/lorelum/`，Plugin manifest ID SHALL 为 `lorelum`，且用户可见显示名 SHALL 为 **Lorelum**
