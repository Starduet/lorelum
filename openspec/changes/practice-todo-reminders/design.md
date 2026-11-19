# Design

## Context

此变更解决规划时遗漏后续检索事项的问题。现有 Skill 和 CLI 已提供按需语义检索、全文读取和失败恢复；不重复规定开发生命周期。

## Goals / Non-Goals

- 目标：在 Agent 已经列计划时，用简短提示把具体检索问题放到相关步骤。用真实 omp 分别观察提醒写入、回传、节点查询、全文读取和产物应用。
- 非目标：保证模型遵循、给已有计划补写提醒、创造新载体、修复 RPC 首条请求可见性、自动执行查询、证明漏查率下降或验证所有宿主。`lore get` 的固定尾注独立于本变更。

## Decisions

- `scripts/skill-guidance/profiles.ts` 的 Skill 描述承担规划提醒；`scripts/skill-guidance/content/skill.md.tmpl` 的短正文说明按需 query、全文 get、用户授权及不得为 Lorelum 创建或重置计划。通过原生成器生成 portable 与宿主文件。
- 计划只记录后续要解决的问题和时机，不要求写入 Practice 正文或已读指导。宿主能安全更新时使用已有能力；不要求额外的计划编辑操作。Catalog 既有发现路径与精确 ID 直读分开，仍沿用 CLI 的发现、全文读取和恢复合同。
- 在 omp 的常规路径中，`todo done` 可把下一阶段任务随工具结果带入后续模型请求；`todo view` 可读取当前状态。Lorelum 不增加注入逻辑。RPC `set_todos` 的状态确认不等于下一条模型请求已包含该更新。

## Observed Evidence

- 原生 Skill 对照：omp 18.17.0、`openai/gpt-6.2-sol` medium、Lorelum CLI 0.1.0-alpha.7、临时 Northstar Pack。启用 Skill 的首版 todo 在验收阶段写了查阅 Practice；关闭时没有。两组都在保存初始清单后查询、读取 `northstar.csv.rejection`，并交付第 3 行和 `QTY_FORMAT_INVALID`。
- 单独的 todo 来源探针：用户消息没有查询要求，查询问题仅预置在 todo。一次正常推进中，`todo done` 的结果把新查询事项带进模型请求；模型此后针对物理行号和稳定错误码查询、读取并应用。主动 `todo view` 也可带回同一事项。无事项的对照仍能查询并交付正确结果，故不证明 todo 提高检索或应用率。
- 保留边界与反例：两组已有计划的四次运行均保留原任务和状态，但未补写提醒。另一次预置探针，模型在收到查询事项前调用 `init` 覆盖了原计划。三次 RPC 可见性探针均显示更新已写入、第一条请求未带新任务、后续请求才通过宿主提醒带回。原生测试环境的初期工具配置失败不计作成功。

## Risks / Trade-offs

短文案与现有工具回传足以使链路可用，不给模型行为或 todo 保留作强制保证。旧全生命周期、多载体与 A/B/C 评估移出本次交付，历史结果留在任务记录；其他宿主和漏查率改善未验证。
