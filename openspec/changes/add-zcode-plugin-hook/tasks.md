# tasks — add-zcode-plugin-hook

## 1. CLI:`lore hook zcode` ABI

- [x] 1.1 新增 `packages/cli/src/hook/host-hook.ts` 共享核心（按宿主后缀参数化的 argv 解析、stdin payload 解析、Catalog 响应构建、降级输出流程），并把 `codex.ts` 重构为内部委托且公共导出签名不变 — verify `bun test packages/cli/src/hook` 中既有 `codex.test.ts`、`pack-catalog.test.ts` 原样通过
- [x] 1.2 新增 `packages/cli/src/hook/zcode.ts`（`parseZcodeHookInvocation`/`runZcodeHook`/`createZcodeHookResponse`/`buildZcodeHookResponse` 及类型），在 `main.ts` `run()` 增加 zcode 拦截分支与 `RunOptions.zcodeHookServices`，并在 `index.ts` 导出 — verify `bun packages/cli/src/main.ts hook zcode` 能被识别（未知参数仍走正常错误 envelope）
- [x] 1.3 新增 `packages/cli/src/hook/zcode.test.ts`：成功 envelope、畸形 JSON/非对象/非 SessionStart 事件/Store 失败降级（stdout 恰为 `{"continue":true}`、stderr 以 `lore hook zcode degraded: ` 开头、退出码 0）、argv 解析（`--store-root` 两种形式、多余 positional 拒绝） — verify `bun test packages/cli/src/hook/zcode.test.ts` 通过

## 2. CLI 集成测试

- [x] 2.1 新增 `packages/cli/integration/scenarios/hook-zcode.ts`（编译二进制 + stdin 管道：成功、畸形 payload、非 SessionStart、Store 不可用四类场景），接入 `process.integration.ts` — verify `bun packages/cli/integration/process.integration.ts` 全部通过且 hook-codex 场景不回归

## 3. ZCode Plugin 与 marketplace

- [x] 3.1 创建 `plugins/lorelum-zcode/.zcode-plugin/plugin.json`（name `lorelum-zcode`、version、`commands`/`skills`/`hooks` 相对路径）与 `commands/lore.md`（`/lore`，argument-hint + `skills: lorelum` + `$ARGUMENTS` 空参/有参说明） — verify manifest `name` 匹配 `^[a-z0-9][a-z0-9._-]{0,127}$` 且组件目录存在
- [x] 3.2 创建 `hooks/hooks.json`（SessionStart、matcher `startup|resume|clear|compact`、`"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start`、`timeout: 10`）、polyglot `hooks/run-hook.cmd` 与无扩展名 `hooks/session-start`（包装 `lore hook zcode`，失败回退 `{"continue":true}`，恒退出 0，stdin 直通） — verify `bash plugins/lorelum-zcode/hooks/session-start` 在 PATH 上有 `lore` 时输出 envelope、无 `lore` 时输出 `{"continue":true}`
- [x] 3.3 创建 `skills/lorelum/SKILL.md` 与 `references/semantic-query-recovery.md`（按 Codex 插件 Skill 结构做 ZCode 语境翻译），复制品牌图标到 `assets/`，编写插件 `README.md` — verify Skill 覆盖 `lore pack list --details`、`lore query`、`lore get` 的使用时机与恢复路径
- [x] 3.4 新增仓库根 `.claude-plugin/marketplace.json`（name `lorelum-plugins`、唯一条目 `lorelum-zcode` → `plugins/lorelum-zcode`），更新 `plugins/README.md` 为双宿主描述 — verify Codex 侧 `.agents/plugins/marketplace.json` 无 diff

## 4. Plugin 配置测试

- [x] 4.1 新增 `plugins/lorelum-zcode/scripts/hooks-config.test.ts`：hooks.json 结构断言 + `session-start`/`run-hook.cmd` 脚本契约（含 `lore hook zcode`、无 `bun`/`@lorelum` 引用）+ POSIX 端到端（shim 成功透传、旧 CLI 非零退出回退 `{"continue":true}`） — verify `bun test plugins/lorelum-zcode/scripts` 通过
- [x] 4.2 新增 `plugins/lorelum-zcode/scripts/marketplace-config.test.ts`：manifest 字段/组件路径、`.claude-plugin/marketplace.json` 条目、selector `lorelum-zcode@lorelum-plugins` — verify 与 4.1 一并通过

## 5. 文档

- [x] 5.1 更新维护者文档：`docs/cli/hook.md` 增加 zcode ABI 节、`docs/cli/README.md` 修正"唯一集成 ABI 例外"措辞、`docs/development/plugins.md` 增加 ZCode 插件开发/验证流程 — verify 文内测试命令与实际命令一致
- [x] 5.2 新增 site 双语页 `apps/site/content/docs/zcode.mdx` 与 `zcode.zh.mdx`（Scope/Prerequisites/Install/How it works/Verify/Update/Troubleshoot），在 `meta.json`/`meta.zh.json` 的 Agent integrations 节登记，根 `README.md`/`README.zh-CN.md` 增加 ZCode 集成条目 — verify 中英页面结构对应、meta 无死链

## 6. 全量验证与收尾

- [x] 6.1 运行 `bun test packages/cli/src/hook plugins/lorelum-zcode/scripts plugins/lorelum/scripts`、`bun run typecheck`、`bun run lint` — verify 全部通过
- [x] 6.2 烟测 `printf '{"hook_event_name":"SessionStart"}' | bun packages/cli/src/main.ts hook zcode --store-root <隔离目录>` 输出合法 envelope，并以畸形 payload 验证降级 — verify stdout 恰为一行 JSON
- [x] 6.3 `openspec validate --strict --no-interactive` 通过；按 Conventional Commits 分批提交并逐 diff 复查（无本机产物、密钥或生成文件） — verify `git status` 干净且提交历史符合规范
