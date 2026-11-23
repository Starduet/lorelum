# Spec Delta

## ADDED Requirements

### Requirement: 计划步骤中的 Practice 检索提醒

Lorelum Skill SHALL 指引 Agent 在本就制定计划时，将相关后续步骤所需的具体 Practice 查询问题记在对应步骤。到该步骤时，Skill SHALL 指引 Agent 按需查询、使用 `lore get` 完整读取将采用的 Practice，并在用户授权范围内应用。Skill MUST NOT 指引 Agent 仅为 Lorelum 创建或重置计划，且 SHALL 提醒 Agent 保留既有任务和状态。

此要求约束 Skill 提供的指引。宿主集成 MUST NOT 为此自动查询或自动读取。

#### Scenario: 制定有后续检索需求的计划
- **WHEN** Agent 正在制定计划，且某个后续步骤需要发现适用指导
- **THEN** Skill SHALL 提示在相关步骤写下要查的具体问题，并在该步骤按需查、读和应用

#### Scenario: 已有计划或没有计划
- **WHEN** 当前任务已有计划，或本身不需要计划
- **THEN** Skill SHALL 提示保留既有任务及状态，且 MUST NOT 要求为 Lorelum 补建或重置计划

### Requirement: omp 会话保留待查 Practice 问题

omp 插件 SHALL 从成功的 `todo init` 和 `append` 登记显式标记 `[practice: 问题]`，为问题分配会话内编号，并在成功的 `init`、`append`、`start` 和 `done` 的工具结果中附加当前未关闭提醒。插件 MUST NOT 重写 todo 列表。插件 SHALL 允许通过 `close_lore_lookup` 关闭单个编号，并随当前会话分支恢复登记与关闭状态。

#### Scenario: 重建时遗漏原问题
- **WHEN** 成功的 `todo init` 替换了包含待查问题的计划，新计划未包含原标记
- **THEN** 该未关闭问题 SHALL 仍随结果进入下一次模型请求

#### Scenario: 关闭后切换会话
- **WHEN** Agent 关闭一个提醒，切换到另一会话，再切回
- **THEN** 另一会话 MUST NOT 收到原会话的提醒，原会话的后续更新 SHALL 只附加其仍未关闭的提醒

## MODIFIED Requirements

### Requirement: Catalog-aware targeted retrieval
CLI-first 集成的 Skill SHALL 将已提供的 Installed Pack Catalog 仅作为 routing metadata，而不得将其当成完整 Practice 内容或不存在相关 guidance 的证明。generic Skill 需要发现尚未知晓的指导而任务上下文没有可用 Catalog 时 MUST 执行一次 `lore pack list --details` 并在当前任务复用结果；通过宿主 SessionStart Hook 注入 Catalog 的 Skill MUST 复用它而不得重复 list。仅需读取已知精确 Practice ID、没有其他发现需求时 MUST NOT 仅为该读取建立 Catalog。Hook MUST 保持 metadata-only，且不得自动执行 `lore query` 或 `lore get`。当 Skill 判定 material task、decision、verification、recovery 或 completion moment 需要发现尚未知晓的指导时，MUST 先执行一次针对该缺口的 targeted natural-language semantic query；已知需要读取的精确 Practice ID 时 MAY 直接 get，但若仍需发现其他指导 MUST 针对缺口执行 semantic query。准备使用某个 Practice 前 MUST 读取其完整内容。

Cursor 的 `sessionStart` Hook 是 fire-and-forget，宿主不保证注入的 Catalog 在首个 turn 前可见。因此 Cursor 集成的 Skill SHALL 把「Hook 已注入可用 Catalog」作为条件而不是前提：仅当当前任务上下文实际含有可用的 Installed Pack Catalog 时才进入复用路径；需要发现指导且 Catalog 缺失或不可见时，该 Skill MUST 按 generic Skill 规则为当前任务执行一次 `lore pack list --details`，且该行为 MUST NOT 被视为违反复用纪律。

#### Scenario: Generic Skill establishes a missing Catalog once
- **WHEN** generic Skill 的当前任务上下文没有可用的 Installed Pack Catalog，且当前决策需要发现尚未知晓的指导
- **THEN** Skill MUST 只执行一次 `lore pack list --details` 建立 Catalog，并在后续普通编辑、命令或回复前复用它

#### Scenario: Codex reuses Hook-injected Catalog
- **WHEN** Codex Hook 已向当前任务注入 Installed Pack Catalog，且 Skill 到达需要发现未知指导的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`

#### Scenario: ZCode reuses Hook-injected Catalog
- **WHEN** ZCode 的 SessionStart Hook 已向当前任务注入 Installed Pack Catalog，且 Skill 到达需要发现未知指导的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`

#### Scenario: Cursor reuses a visible Hook-injected Catalog
- **WHEN** Cursor 的 `sessionStart` Hook 注入的 Installed Pack Catalog 实际出现在当前任务上下文中，且 Skill 到达需要发现未知指导的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`

#### Scenario: Cursor establishes the Catalog when injection is absent
- **WHEN** Cursor 会话的任务上下文中没有可见的 Installed Pack Catalog（Hook 未注入、注入延迟或被截断），且 Skill 需要发现未知指导
- **THEN** Skill MUST 为当前任务执行一次 `lore pack list --details` 并复用结果，且该行为 MUST NOT 被判定为违反复用纪律

#### Scenario: WorkBuddy reuses Hook-injected Catalog
- **WHEN** WorkBuddy 的 SessionStart Hook 已向当前任务注入 Installed Pack Catalog，且 Skill 到达需要发现未知指导的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`

#### Scenario: Claude Code reuses Hook-injected Catalog
- **WHEN** Claude Code 的 SessionStart Hook 已向当前任务注入 Installed Pack Catalog，且 Skill 到达需要发现未知指导的 material moment
- **THEN** Skill MUST 使用该 Catalog 执行 targeted semantic query，且不得重新执行 `lore pack list --details`

#### Scenario: Exact Practice is known but coverage remains uncertain
- **WHEN** Agent 知道一个需要采用的精确 Practice ID，但尚未完整读取，且当前决策仍有未知指导缺口
- **THEN** Agent MAY 直接 get 该 ID，但 MUST 另行针对未知缺口 semantic query，并在采用任何候选前完整读取

#### Scenario: Exact Practice is known and no discovery is needed
- **WHEN** Agent 只需读取已知精确 Practice ID，且当前决策没有其他未知指导缺口
- **THEN** Agent MAY 直接 get 该 ID，MUST NOT 仅为读取它执行 semantic query 或建立 Catalog，并 MUST 在采用前读取全文
