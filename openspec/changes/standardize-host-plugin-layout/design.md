## Context

本设计的动机见 [proposal.md](./proposal.md)。当前仓库只有 Codex artifact：`.agents/plugins/marketplace.json:11` 指向 `plugins/lorelum/`，其 manifest、Hook、Skill 和两套配置测试都在同一目录；`docs/development/plugins.md:7,20-21,57` 也将这一旧路径写为维护者合同。PR #193 新增 ZCode 适配器和 `lore hook zcode`，但将 source directory 写为 `plugins/lorelum-zcode/`、registration 写在 `.claude-plugin/marketplace.json`，而官方 ZCode 文档的团队 marketplace 入口是仓库根 `marketplace.json`，且更新比较依赖 marketplace entry version。

`plugins/README.md:3-11` 已确立正确边界：host artifact 独立安装、通过 released CLI 工作、不得创建 future-host placeholder。`skills/lorelum/` 与 `docs/development/skill-guidance-fixtures.md` 已提供可复用的 generic Skill 内容和行为验收，因此不需要建立新的共享 runtime 或 registry。

## Goals / Non-Goals

**Goals:**

- 用一个路径规则消除 `plugins/lorelum` 与 `plugins/lorelum-zcode` 的身份歧义。
- 保留一个稳定产品 ID，同时让源码目录明确表达宿主。
- 用每个宿主的原生 registration 形式发布相应 artifact，并让 ZCode 更新可被发现。
- 给维护者一页可执行规范，并从根 `AGENTS.md` 直接发现它。

**Non-Goals:**

- 不建立 registry、adapter schema、代码生成器、统一 manifest 或自动 marketplace 同步。
- 不新增 Claude Code、Cursor、OpenCode、WorkBuddy、Zed artifact；这些宿主只在规范中作为决策矩阵说明。
- 不把 host-native Hook、command 或 marketplace schema 伪装成可移植协议。
- 不改变现有 Pack、Store、query、ranking、Codex Hook ABI 或用户侧 selector。

## Decisions

### 1. 两层源码命名：产品 ID 与 hostKey 各司其职

所有新增或迁移的 Plugin source root 使用：

```text
plugins/<hostKey>/lorelum/
```

`lorelum` 永远表示产品和宿主 manifest 的默认 ID；`hostKey` 只出现在 source path、维护者文档、测试分组和内部引用。首批值为 `codex` 和 `zcode`。因此 `plugins/codex/lorelum/` 与 `plugins/zcode/lorelum/` 分别是两份不同的 host overlay，但不再把 `lorelum-zcode` 当成用户侧 Plugin ID。

不选择仅按产品分目录：这会再次隐藏 Host-specific Hook、command 和 manifest。也不选择把宿主后缀加到 manifest ID：两个宿主各自有独立 marketplace，用户应安装相同的 Lorelum 产品；强加 `-zcode` 会把 source implementation detail 扩大成公开身份。

### 2. 共享 core，保留 native overlay

`skills/lorelum/` 是没有 Hook 注入条件时的 portable Skill core。`plugins/<hostKey>/lorelum/skills/lorelum/` 是该宿主的发布内容：可以针对 injected Catalog 或宿主恢复方式做措辞翻译，但需通过现有 skill-guidance fixtures 保持 query/get/recovery 行为。`lore hook` 的 Catalog 渲染与失败降级逻辑属于 CLI；`lore hook codex` 和 `lore hook zcode` 是很薄的宿主 ABI。

manifest、marketplace registration、Hook command、环境变量、执行模式、宿主确有需要时的平台 wrapper，以及 slash command 都是 native overlay，必须随各宿主目录维护，不尝试合并为一个文件。

### 3. Registration 遵从官方宿主入口，并将版本视为 release contract

Codex 继续使用 `.agents/plugins/marketplace.json`，只把 source path 更新到 `./plugins/codex/lorelum`。ZCode 使用仓库根 `marketplace.json`，entry 指向 `./plugins/zcode/lorelum` 并含 `version`；它与 `plugins/zcode/lorelum/.zcode-plugin/plugin.json` 的 version 由配置测试一起断言。不要保留 `.claude-plugin/marketplace.json` 副本：双 registration 会制造漂移，并把客户端兼容探测当成公开合同。

同名的 `lorelum@lorelum-plugins` 是 host-local selector：它在 Codex 和 ZCode 各自的 marketplace 内指向唯一 artifact，不是两套 source 的全球唯一主键。维护者规范必须明确这一点。

### 4. 规范文档和 AGENTS 只承担导航与决策，不替代 host documentation

新增 `docs/development/plugin-conventions.md`，控制在一页左右，包含：术语、路径/ID/selector 映射、可共享与 native-only 的边界、当前支持矩阵、接入新宿主的准入检查、版本与测试要求。`AGENTS.md` 新增 `plugins` 行并链接该文档；`docs/development/README.md` 链接此页面。`docs/development/plugins.md` 保留 checkout、Codex/ZCode 操作和验证命令，不重复概念规则。

### 5. 用户文档按“装好、用上、出问题”组织，内部机制移出主路径

当前 `agent-setup` 与 Codex 页面把用户安装步骤、Agent 运行指令、Catalog 字段、`packRoot`、semantic runtime、Hook ABI、MCP 边界和维护者环境信息交织在一起。实施时以用户任务而非内部组件分页：

1. `agent-setup` 中英文页只回答选择哪种接入、把 Skill/Plugin 装到哪里、如何在新任务中验证它开始工作，以及遇到“Agent 没有调用 Lorelum”时下一步检查什么。
2. Codex 和 ZCode 中英文页只保留宿主各自的安装、更新、启用前置条件和短故障排查。Codex 和 ZCode 用户都不需要了解 Bun、MCP、Store、Hook envelope、Catalog 截断或 `packRoot`；安装的 ZCode Plugin 会自行激活其 Hook，无需额外启用配置文件 Hook。
3. `agents.mdx`/`agents.zh.mdx` 是给可执行命令的 Agent 或高级用户复制给 Agent 的 reference。它可以保留精确 CLI/recovery 合同，但 `agent-setup` 和宿主安装页不得要求普通用户阅读它，也不得以它解释安装流程。

安装、升级和故障恢复的普通用户动作仍由站点中英文页承担；CLI ABI、Plugin source root、host Hook payload、Bun/validator 和 no-local-MCP 的理由归属 maintainer docs、current specs 或 Agent-facing reference。这样不会删掉信息，只会把它放回正确读者的位置。

## Risks / Trade-offs

- [目录迁移遗漏 checkout、validator 或 markdown 链接] → 用 `rg` 全量检查旧路径，配置测试和相对链接检查作为门禁。
- [ZCode PR 的已验证 bundle fallback 与官方入口不同] → 以官方根 `marketplace.json` 为 canonical；仅对该路径做 clean-host install/update smoke test，不保留未验证副本。
- [同 selector 被误解为同一 source] → 规范与 distribution spec 明确它仅在 host-local marketplace 中唯一；每个 marketplace 文件只声明自己的 host artifact。
- [Skill 内容复制漂移] → fixture 验证 observable retrieval behavior，不要求字节级相同。
- [简化用户页时丢失真实恢复入口] → 每个宿主页保留一个可执行的安装后验证和最短故障路径；精确协议细节转移到维护者/Agent reference 而不是删除。

## Migration Plan

1. 在实现 worktree 中以 PR #193 head 为 ZCode 功能基线，保留其 CLI Hook shared core 和 host tests。
2. 移动现有 Codex artifact 到 `plugins/codex/lorelum/`，移动 ZCode artifact 到 `plugins/zcode/lorelum/`，再更新其 tests、marketplace source、cachebuster、validator 和所有维护者链接。
3. 以仓库根 `marketplace.json` 取代 PR 的 `.claude-plugin/marketplace.json`，补齐并锁定 ZCode entry version。
4. 新增规范与 `AGENTS.md` / development index；重写中英文 Agent、Codex 和 ZCode 用户文档的阅读路径，保持公开 selector 不变，并将内部细节保留在维护者或 Agent-facing reference。
5. 在 clean Codex 和 ZCode local marketplace 安装中验证新目录、Hook、Catalog 和 ZCode update；失败时恢复同一变更中的 source path 与 registration 文件，用户 selector 无需迁移。
