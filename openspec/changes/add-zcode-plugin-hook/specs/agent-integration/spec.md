# agent-integration delta — add-zcode-plugin-hook

## ADDED Requirements

### Requirement: ZCode session Hook ABI

`lore hook zcode` SHALL 作为 raw 版本化集成 ABI 运行：从 stdin 读取单个 JSON 对象 payload，当 `hook_event_name` 为 `SessionStart` 时，MUST 通过既有 list 服务取得 Installed Pack Catalog，并向 stdout 输出一行 ZCode Hook envelope `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<bounded catalog>"}}`。stdout MUST 只包含该协议响应，诊断 MUST 写入 stderr。payload 畸形、事件不受支持、Store 不可用或其他内部失败时，命令 MUST 降级为向 stdout 输出 `{"continue":true}`、向 stderr 写入以 `lore hook zcode degraded: ` 开头的诊断，并以退出码 0 结束，MUST 不阻塞宿主会话。该命令 MUST 复用 `lore hook codex` 的 Catalog 检索与渲染语义，MUST 不复制 Store 访问、Pack 发现或排序逻辑；`lore hook codex` 的可观察行为 MUST 保持不变。

#### Scenario: SessionStart injects the bounded catalog

- **WHEN** `lore hook zcode` 从 stdin 收到 `{"hook_event_name":"SessionStart"}`
- **THEN** stdout MUST 只包含一行 `hookSpecificOutput` envelope，其 `additionalContext` 为有界的 Installed Pack Catalog 渲染，stderr MUST 为空，退出码 MUST 为 0

#### Scenario: Unsupported or malformed input degrades safely

- **WHEN** stdin payload 为畸形 JSON、非 JSON 对象，或 `hook_event_name` 不是 `SessionStart`
- **THEN** 命令 MUST 向 stdout 输出 `{"continue":true}`，向 stderr 写入诊断，并以退出码 0 结束

#### Scenario: Unavailable Store degrades safely

- **WHEN** Catalog 检索因 Store 不可用或 list 服务失败而无法完成
- **THEN** 命令 MUST 向 stdout 输出 `{"continue":true}`，向 stderr 写入失败诊断，并以退出码 0 结束

#### Scenario: Codex Hook ABI stays unchanged

- **WHEN** `lore hook codex` 以既有 Codex payload 被调用
- **THEN** 其 envelope、stdout/stderr 约定与退出码 MUST 与该命令引入 ZCode 支持之前完全一致

## MODIFIED Requirements

### Requirement: Catalog-aware targeted retrieval

CLI-first 集成的 Skill SHALL 将已提供的 Installed Pack Catalog 仅作为 routing metadata，而不得将其当成完整 Practice 内容或不存在相关 guidance 的证明。generic Skill 在任务上下文没有可用 Catalog 时 MUST 执行一次 `lore pack list --details` 并在当前任务复用结果；宿主 Skill（Codex、ZCode）在 Hook 已注入 Catalog 时 MUST 复用它而不得重复 list。Hook MUST 保持 metadata-only，且不得自动执行 `lore query` 或 `lore get`。当 Skill 判定 material task、decision、verification、recovery 或 completion moment 值得检索时，MUST 先执行一次 targeted natural-language semantic query；准备使用某个 Practice 前 MUST 读取其完整内容。

#### Scenario: Generic Skill establishes a missing Catalog once

- **WHEN** generic Skill 的当前任务上下文没有可用的 Installed Pack Catalog，且需要检索 guidance
- **THEN** Skill MUST 只执行一次 `lore pack list --details` 建立 Catalog，并在后续普通编辑、命令或回复前复用它

#### Scenario: Codex reuses Hook-injected Catalog

- **WHEN** Codex Hook 已向当前任务注入 Installed Pack Catalog，且 Skill 到达值得检索的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`

#### Scenario: ZCode reuses Hook-injected Catalog

- **WHEN** ZCode Hook 已向当前会话注入 Installed Pack Catalog，且 Skill 到达值得检索的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`
