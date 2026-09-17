# add-zcode-plugin-hook

## Why

Lorelum 已为 Codex 提供第一方 Plugin 与 `lore hook codex` 集成 ABI，但 ZCode 用户只能手动运行 `lore` CLI，没有宿主原生的 Plugin、`/lore` 命令或会话级 Pack Catalog 注入。issue #175 要求补齐第一方 ZCode 集成，使 ZCode 与 Codex 获得一致的 CLI-first 集成体验。

本 change 引入新的产品行为（新增 ZCode Plugin 与 `lore hook zcode` 命令），不记录既有行为；现有 `lore hook codex` ABI 与 Codex Plugin 行为 MUST 保持向后兼容。

## What Changes

- 新增 `lore hook zcode` CLI 命令：作为 raw 版本化 ABI 在 Commander 之前拦截，从 stdin 读取 ZCode Hook payload，仅支持 `SessionStart` 事件，复用现有 Pack Catalog 检索（`listPackDetails`）与渲染（`renderPackCatalog`），向 stdout 输出 ZCode Hook response envelope（`hookSpecificOutput.hookEventName: "SessionStart"` + `additionalContext`），诊断写入 stderr，任何失败降级为 `{"continue":true}` 且退出码为 0。
- 从 `lore hook codex` 实现中抽取宿主无关的 Hook 共享核心（argv 解析、payload 解析、响应构建、降级流程），`codex.ts` 公共 API 与行为零变化，新增 `zcode.ts` 薄适配层。
- 新增 ZCode Plugin `plugins/lorelum-zcode/`：`.zcode-plugin/plugin.json` manifest（插件名 `lorelum-zcode`）、`commands/lore.md`（`/lore` 命令，接受可选自然语言问题）、`skills/lorelum/SKILL.md` 与 recovery reference、`hooks/hooks.json`（SessionStart，经宿主原生变量 `${ZCODE_PLUGIN_ROOT}` 调用跨平台包装脚本执行 `lore hook zcode`）、品牌图标、README 与 Plugin 配置测试。
- 新增 ZCode marketplace 配置 `.claude-plugin/marketplace.json`（ZCode 添加 GitHub 仓库/local 目录时探测的路径）：marketplace 名称 `lorelum-plugins`，唯一插件条目 `lorelum-zcode` → `plugins/lorelum-zcode`，完整 selector 为 `lorelum-zcode@lorelum-plugins`。
- 更新维护者文档（`docs/cli/`、`docs/development/plugins.md`）与用户双语文档（site `zcode` 页面、根 README），说明 ZCode 安装、验证与故障排查。
- 不改变 Codex marketplace（`.agents/plugins/marketplace.json`）、Codex Hook ABI 或 Codex Plugin 行为。

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `agent-integration`: 新增 `lore hook zcode` 会话 Hook ABI 的可观察合同（stdin payload、SessionStart-only、envelope、stdout 纯协议输出、stderr 诊断、安全降级）；并将 Hook 注入 Catalog 的复用规则从 Codex 专称扩展到 Codex 与 ZCode 两个宿主 Skill。
- `plugin-distribution`: "Single public Plugin identity" 从 Codex 单宿主扩展为双宿主身份——Codex 侧保持 `lorelum@lorelum-plugins`（`.agents/plugins/marketplace.json`），ZCode 侧新增 `lorelum-zcode@lorelum-plugins`（`.claude-plugin/marketplace.json`），各自指向独立的 Plugin 源目录；runtime boundary 同样约束 ZCode Plugin。

## Impact

- 受影响代码：`packages/cli/src/hook/`（新增 `host-hook.ts` 共享核心与 `zcode.ts`，重构 `codex.ts` 内部委托）、`packages/cli/src/main.ts`（新增 zcode 拦截分支与 `RunOptions.zcodeHookServices` 测试缝）、`packages/cli/src/index.ts`（导出 zcode hook API）、`packages/cli/integration/`（新增 hook-zcode 场景）。
- 新增分发产物：`plugins/lorelum-zcode/`、仓库根 `.claude-plugin/marketplace.json`；更新 `plugins/README.md`。
- 受影响文档：`docs/cli/hook.md`、`docs/cli/README.md`、`docs/development/plugins.md`、site `apps/site/content/docs/zcode.mdx` 与 `zcode.zh.mdx` 及 `meta.json`/`meta.zh.json`、根 `README.md`/`README.zh-CN.md`。
- 不受影响：Engine/Backend 检索与排名语义、Pack format、Codex Hook ABI（`lore hook codex` envelope 与行为不变，现有测试原样通过）、Codex Plugin 分发。
- 明确边界：不引入本地 MCP server、MCP tools 或 MCP-backed Plugin 行为；Plugin 不导入 Engine/Backend 包、不直接读取 LocalStore，只调用 `PATH` 上已发布的 `lore` 可执行文件。
