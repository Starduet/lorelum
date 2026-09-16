# design — add-zcode-plugin-hook

## Context

- `lore hook codex`（issue #136）确立了 raw 版本化集成 ABI 模式：在 `main.ts` 的 `run()` 中于 Commander 解析前拦截 `hook codex` argv，从 stdin 读取 payload，经 `createListService().listPackDetails` 取得 Installed Pack Catalog，用 `renderPackCatalog`（4000 字符预算）渲染，向 stdout 输出一行 Hook envelope；任何失败降级为 `{"continue":true}` + stderr 诊断 + 退出码 0。实现位于 `packages/cli/src/hook/codex.ts`，渲染器 `pack-catalog.ts` 与 Store-root 解析 `store/storage-root.ts` 已经是可复用模块。
- Codex Plugin（`plugins/lorelum/`）确立了第一方宿主插件结构：`.codex-plugin/plugin.json` manifest、Skill + reference、`hooks/hooks.json`、`scripts/` 配置测试、README;marketplace 条目位于仓库根 `.agents/plugins/marketplace.json`。
- ZCode 宿主格式已实测取证（本机官方插件与客户端 bundle）：manifest 按顺序探测 `.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json`，`name` 须匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`，支持 `commands`/`skills`/`hooks` 组件路径；marketplace 探测仓库根 `.claude-plugin/marketplace.json`，schema 为 `{ name, plugins[], pluginRoot? }`，`plugins[].source` 可为相对路径字符串，插件身份为 `<name>@<marketplace>`；Hook 支持 `SessionStart` 事件（stdin payload 含 `hook_event_name`），响应 envelope 与 Codex 同形（`hookSpecificOutput.hookEventName` + `additionalContext`），支持 `timeout` 字段，**不支持** `commandWindows` 与 `additionalContextLimit`（bundle 内零匹配）；官方 superpowers 插件以 polyglot `run-hook.cmd` 包装 + 无扩展名 POSIX 脚本 + `${CLAUDE_PLUGIN_ROOT}` 变量实现跨平台 Hook 命令；Command 为 `commands/*.md`，front-matter 含 `description`/`argument-hint`/`skills`，正文以 `$ARGUMENTS` 展开参数。

## Goals / Non-Goals

**Goals:**

- ZCode 用户获得与 Codex 对等的第一方集成：marketplace 安装、`/lore` 命令、宿主原生 Skill、SessionStart 注入有界 Installed Pack Catalog。
- `lore hook zcode` 成为明确的 ZCode Hook ABI，同时 Catalog 检索与渲染逻辑与 codex 共享，不复制 Store 访问、Pack 发现或排序。
- `lore hook codex` 公共 API、envelope 与可观察行为零变化（现有测试原样通过）。
- 全链路测试：CLI 单元、编译二进制集成、插件配置测试。

**Non-Goals:**

- 不修改 Codex Hook ABI、Codex Plugin 或 Codex marketplace（`.agents/plugins/marketplace.json`）。
- 不引入本地 MCP server/MCP tools/MCP-backed Plugin 行为（遵守 agent-integration 的 No local MCP surface）。
- 不改变 Engine/Backend 检索、排名、模型或持久化行为。
- 不做 file-change 触发器、自动 intent 识别，或 ZCode 专属的托管/远程基础设施。

## Decisions

### 1. 插件身份与 marketplace 布局

**Proposed:** 目录 `plugins/lorelum-zcode/`，manifest name `lorelum-zcode`；仓库根新增 `.claude-plugin/marketplace.json`，marketplace 名称 `lorelum-plugins`，唯一条目 `lorelum-zcode` → `plugins/lorelum-zcode`；完整 selector `lorelum-zcode@lorelum-plugins`。Codex 侧 `.agents/plugins/marketplace.json` 保持不动。

**Why this over alternatives:** ZCode 添加 marketplace 时只探测 `.claude-plugin/marketplace.json`，且其 source schema（directory/github/git/url）与 Codex 的 `{source:"local", path}` + `policy` 不兼容，合并成一份文件会迫使两个宿主解析对方的专有字段。插件名用 `lorelum-zcode` 而非复用 `lorelum`：issue 明确要求独立目录 `plugins/lorelum-zcode/`，且若用户在同一宿主同时添加两个来源，同名不同实现的 Plugin ID 会造成身份冲突；`lorelum-zcode@lorelum-plugins` 保持与 Codex 一致的品牌 namespace，同时身份无歧义。

**Alternatives considered:** 复用 `.agents/plugins/marketplace.json`（ZCode 不探测该路径，且 schema 不兼容）；插件名沿用 `lorelum`（依赖 ZCode 的 manifest 回退探测加载 `.codex-plugin`，但两宿主插件内容必然分叉，留下身份冲突隐患）。

### 2. `lore hook zcode` 作为独立 raw ABI，共享核心抽取

**Proposed:** 镜像 codex 的拦截模式：新 `packages/cli/src/hook/host-hook.ts` 承载宿主无关核心（按 host 后缀参数化的 argv 解析、stdin payload 解析、Catalog 响应构建、降级输出流程）；`codex.ts` 保留全部现有导出签名、内部委托共享核心；新增 `zcode.ts` 薄适配层（`parseZcodeHookInvocation`/`runZcodeHook`/`createZcodeHookResponse`/`buildZcodeHookResponse` 及类型）；`main.ts` 在 codex 分支后增加 zcode 分支，`RunOptions` 增加 `zcodeHookServices` 测试缝。envelope、`SessionStart`-only、`{"continue":true}` 降级、stderr 前缀 `lore hook zcode degraded: `、退出码恒 0——与 codex 语义一致，仅命令名与诊断标签不同。

**Why this over alternatives:** issue 明确拒绝直接复用 `lore hook codex`（宿主边界会被语义绑死在 Codex），也要求"Share or extract common Pack Catalog Hook logic"。raw-argv 拦截避免把 Hook envelope 混入 Commander 的 JSON envelope 渲染路径，这是 #136 已验证的模式；共享核心让两个宿主 ABI 的演化可以在同一模块内对齐而不互相复制。

**Alternatives considered:** 让 `parseCodexHookInvocation` 同时接受 `zcode`（单函数双宿主，但导出语义混乱，codex 模块被迫感知 zcode）；完整复制 `codex.ts` 为 `zcode.ts`（违背 issue 第 7 条范围，双份降级逻辑易漂移）。

### 3. 跨平台 Hook 命令：polyglot 包装脚本

**Proposed:** `hooks/hooks.json` 的 SessionStart 条目引用 `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start`（`timeout: 10`，matcher `startup|resume|clear|compact`）；`run-hook.cmd` 为 polyglot 脚本（Windows 段由 cmd.exe 执行、定位 Git Bash 后运行无扩展名 POSIX 脚本 `hooks/session-start`，Unix 段直接以 bash 执行同一脚本，找不到 bash 时静默退出 0）；`session-start` 包装 `lore hook zcode`——成功透传 stdout，非零退出或 CLI 缺失时打印 `{"continue":true}`，始终退出 0，stderr 原样透传给宿主。

**Why this over alternatives:** 实测 ZCode 不支持 `commandWindows`（Codex 插件解决 Windows 的方式在 ZCode 无效），也不支持 `additionalContextLimit`（上下文预算完全由 `renderPackCatalog` 的 4000 字符上限保证，与 codex 相同）。polyglot + `${CLAUDE_PLUGIN_ROOT}` 是官方 superpowers 插件验证过的模式。外层脚本兜底保证"CLI 不在 PATH / 旧版本 CLI 非零退出"时宿主仍收到合法 envelope，与 Codex 插件的外层回退语义一致。matcher 用非锚定 `startup|resume|clear|compact`（官方插件同款写法，ZCode 的 SessionStart source 取值已实测确认）。

**Alternatives considered:** hooks.json 内联 POSIX 命令（Windows 上 ZCode 无 `commandWindows` 可用，内联 shell 语法跨平台不可靠）；`lore hook zcode` 裸命令（CLI 自身已能降级，但 CLI 缺失/过旧时无 envelope 兜底，不满足"unavailable CLI degrades safely"）。

### 4. `/lore` 命令与 Skill 措辞

**Proposed:** `commands/lore.md` 使用 ZCode 命令格式（front-matter `description`/`argument-hint: "[question]"`/`skills: lorelum`，正文 `Use the \`lorelum\` skill for this request:`+`$ARGUMENTS`+ 空参/有参两种检索焦点说明）。Skill`skills/lorelum/SKILL.md`与`references/semantic-query-recovery.md`按 Codex 插件 Skill 结构做 ZCode 语境翻译：复用 Hook 注入的 Catalog、material moment 执行 targeted`lore query`、`lore get`读全文、资源经`packRoot` 解析、失败后按 recovery reference 处理。

**Why this over alternatives:** agent-integration spec 允许宿主文档按自身语境表达（"宿主文档可按自身语境表达，不要求文案一致"），且 ZCode 的命令入口（`/lore`）是 issue 的显式验收项；Codex 插件没有 commands 组件，两宿主入口差异由各自的宿主机制决定。

## Risks / Trade-offs

- [ZCode 客户端格式为实测推断，版本升级可能改变探测路径或字段] → manifest 同时符合 ZCode 与通用 schema 约束（name 正则、相对组件路径）；插件配置测试锁定 hooks/marketplace/manifest 结构，客户端行为变化会在 `bun test plugins/lorelum-zcode/scripts` 中显式暴露。
- [polyglot 脚本依赖 Windows 上存在 Git Bash] → 找不到 bash 时静默退出 0（无注入、不阻塞会话），README 与 site 故障排查说明该边界；`lore hook zcode` CLI 本身跨平台纯 TypeScript，不受影响。
- [无 `additionalContextLimit` 字段，上下文预算只靠渲染器] → `renderPackCatalog` 的 4000 字符硬上限已覆盖此风险，且为两个宿主共享同一实现。
- [共享核心重构可能引入 codex 回归] → `codex.ts` 公共导出签名不变；现有 `codex.test.ts`/`pack-catalog.test.ts`/`hook-codex.ts` 集成场景原样保留作为回归门禁。
- [双 marketplace 文件并存增加维护面] → 各自的配置测试断言条目与路径；`plugins/README.md` 明确两个宿主各自的分发文件。

## Migration Plan

1. 合入本 change（CLI 命令 + 插件 + marketplace 文件 + 文档）。
2. 用户侧为纯增量：ZCode 用户按 site `zcode` 页面添加 marketplace 并安装；Codex 用户无需任何操作。
3. 发布：`lore` 可执行文件随常规 CLI release 分发；插件版本独立演进（初始 `0.1.0-alpha.1`）。

**Rollback:** 移除 `plugins/lorelum-zcode/` 与 `.claude-plugin/marketplace.json` 即可撤销插件分发；`lore hook zcode` 分支为独立拦截路径，保留不影响其他命令，若需回滚可整体 revert 对应提交。

## Open Questions

_None._（ZCode 的 manifest/marketplace/hook/envelope 格式均已对本机官方插件与客户端 bundle 完成取证；如后续 ZCode 正式发布插件开发者文档且与本设计冲突，以新提案处理。）
