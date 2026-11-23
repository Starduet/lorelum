# Design

## Context

此变更解决规划时遗漏后续检索事项的问题。现有 Skill 和 CLI 已提供按需语义检索、全文读取和失败恢复；不重复规定开发生命周期。

## Goals / Non-Goals

- 目标：在 omp 使用显式计划标记登记问题，在重建或推进后回传未关闭提醒，并支持关闭指定问题。
- 非目标：自动查询、推断模型是否使用了指导、修改 RPC 或其他宿主的 todo 行为。

## Decisions

- `scripts/skill-guidance/profiles.ts` 的 Skill 描述承担规划提醒；`scripts/skill-guidance/content/skill.md.tmpl` 的短正文说明按需 query、全文 get、用户授权及不得为 Lorelum 创建或重置计划。通过原生成器生成 portable 与宿主文件。
- 计划只记录后续要解决的问题和时机，不要求写入 Practice 正文或已读指导。宿主能安全更新时使用已有能力；不要求额外的计划编辑操作。Catalog 既有发现路径与精确 ID 直读分开，仍沿用 CLI 的发现、全文读取和恢复合同。
- omp 扩展仅从成功的 `todo init` 和 `append` 提取 `[practice: 问题]`。会话自定义条目保存问题和关闭状态，按当前会话分支恢复。只给成功的计划更新附加提醒文本，保持宿主列表和状态。
- `close_lore_lookup` 按编号关闭一项。成功调用 `get` 可能对应其他问题，`todo done` 也可能只标记规划结束，所以二者不隐式关闭提醒。

## Observed Evidence

- 原生 Skill 对照：omp 18.17.0、`openai/gpt-6.2-sol` medium、Lorelum CLI 0.1.0-alpha.7、临时 Northstar Pack。启用 Skill 的首版 todo 在验收阶段写了查阅 Practice；关闭时没有。两组都在保存初始清单后查询、读取 `northstar.csv.rejection`，并交付第 3 行和 `QTY_FORMAT_INVALID`。
- 单独的 todo 来源探针：用户消息没有查询要求，查询问题仅预置在 todo。一次正常推进中，`todo done` 的结果把新查询事项带进模型请求；模型此后针对物理行号和稳定错误码查询、读取并应用。主动 `todo view` 也可带回同一事项。无事项的对照仍能查询并交付正确结果，故不证明 todo 提高检索或应用率。
- 保留边界与反例：两组已有计划的四次运行均保留原任务和状态，但未补写提醒。另一次预置探针，模型在收到查询事项前调用 `init` 覆盖了原计划。三次 RPC 可见性探针均显示更新已写入、第一条请求未带新任务、后续请求才通过宿主提醒带回。原生测试环境的初期工具配置失败不计作成功。

## Risks / Trade-offs

回传确保已登记的问题出现在工具结果中。模型何时查询取决于任务和上下文。已有小样本压缩对照未观测到查阅率提升。
