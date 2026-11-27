# Proposal

## Why

Agent 制定多步计划时，可能没有记下后续哪个决定需要查 Practice。用一条短规划提示把具体检索问题留在相关步骤，不把 Skill 写成全生命周期手册。

在 omp 中，重建 todo 不能丢掉待查问题。当前原型虽然能保留问题，但查阅后还要单独关闭；如果压缩摘要保留了已经处理的提醒，也没有机制阻止按旧编号再次检索。

## What Changes

- 新增模型指引：Agent 已在列计划时，把相关后续步骤需要查的具体问题写在该步骤；到步骤时按需 `lore query`，用 `lore get` 读全文，在用户授权范围内应用。
- 保留已有任务和状态，不为 Lorelum 单独创建或重置计划。没有计划时仍可按现有方式查询；不要求给既有计划补写提醒，不规定计划文档或交接等备用载体。
- omp 保存并回传待查动作，允许 Agent 在一次 `lore query/get … --todo <编号>` 调用中执行并移除对应提醒。不新增普通检索的前置检查，不修改 omp 原生 todo。

## 产品说明

用户照常提出多步任务，不需要写 Practice ID。例如，Agent 先交付项目清单，再设计导入验收用例；如果它本来就要列 todo，验收步骤可写为「设计 CSV 验收用例前，查非数字数量的拒绝行号和错误码约定」。完成清单后，omp 的 todo 工具结果可以把后续事项交回模型。进入验收时，Agent 按需检索和阅读，再把适用的行号与错误码写入验收 JSON。不是用户操作 todo 就会自动查询。

例如，Agent 先列出「决定 CSV 拒绝记录的错误码 `[query: 非数字数量应使用哪个错误码？]`」和「读取既定错误报告约定 `[get: pack.example.error-reporting]`」（ID 为示例）。omp 返回两个待查编号。用户要求把计划合并为「完成验收」，新列表不含标记，但模型仍能收到两个待查动作：

```sh
lore query "非数字数量应使用哪个错误码？" --todo P1
lore get pack.example.error-reporting --todo P2
```

查询返回候选或正常结束但没有候选时，`P1` 都移出待查清单。全文读取成功才移除 `P2`。若旧摘要仍提到 `P1`，再次按该编号调用只返回「已处理，未检索」。

用户可要求 Agent 撤销指定编号。Agent 通过 omp 的 Bash 提交 `: lorelum-cancel --todo P2`，审批和保存成功后同次返回撤销回执，原计划照常推进。

查询失败、仍在准备或操作被取消时，提醒保留。按原有错误或准备提示处理，不自动重试。`check` 直接写成可观察的普通 todo 步骤，例如「核对验收 JSON 的原始行号和错误码」。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `agent-integration`：从短规划提示延伸到 omp 原生 todo 的查询和读取提醒、跨重建保存，以及以一次调用执行并消费提醒。Catalog 的发现规则不变。

## Impact

共享 Skill、宿主生成文件、omp 扩展及双语接入说明。`--todo` 是 omp Bash 集成提供的显式交互，不要求通用 CLI 读写宿主会话。
