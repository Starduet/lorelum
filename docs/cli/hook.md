# Host Hooks (Codex / ZCode)

`lore hook codex` 与 `lore hook zcode` 是 Lorelum CLI 分别与 Codex Plugin、ZCode Plugin 之间的版本化集成 ABI。它们从 stdin 读取宿主 Hook payload，并在 stdout 输出一行宿主 Hook envelope；它们不输出普通 Lorelum CLI JSON envelope。两个命令共享同一 Pack Catalog 检索与渲染实现（`packages/cli/src/hook/host-hook.ts` 与 `pack-catalog.ts`），仅命令名、stderr 诊断前缀和宿主边界不同。

```sh
printf '%s\n' '{"hook_event_name":"SessionStart"}' | lore hook codex
printf '%s\n' '{"hook_event_name":"SessionStart"}' | lore hook zcode
```

成功时，stdout 是包含 `hookSpecificOutput.hookEventName` 和受限 `additionalContext` 的对象。Catalog 包含已安装 Pack 的名称、版本、可选 description、`appliesTo` 与当前 `packRoot`；它只是 Pack-level 的检索路由提示，不是完整 Practice 内容，也不包含 resource 文件清单或内容。`packRoot` 是可直接读取的 `current` view，而不是内部 digest 路径；后续 mutation 后它可能解析到新 bytes 或消失。需要按当前 source 使用资源时运行 `lore get` 或 `lore pack list` 刷新，不要推导 Store 内部路径。

两个 Hook 都只支持 `SessionStart`。生命周期来源（例如 `compact`）由各宿主 Plugin 的 `hooks.json` matcher 决定，CLI 不推断启动、恢复、清理或 compact 时机。它们不会主动 query/get Practice、启动 Backend、下载模型、构建 index 或修改 Store。

Hook payload 无效、事件不支持或 Store 读取失败时，命令会向 stderr 写诊断（前缀分别为 `lore hook codex degraded: ` 与 `lore hook zcode degraded: `），并在 stdout 输出：

```json
{ "continue": true }
```

这样宿主可以继续运行，不把 Lorelum 的本地问题当作会话阻塞。该 Hook 执行路径以退出码 `0` 返回；无效的 CLI 参数仍按普通 CLI 用法错误处理。

需要隔离 Store 时，使用全局选项：

```sh
printf '%s\n' '{"hook_event_name":"SessionStart"}' \
  | lore hook zcode --store-root /absolute/path/to/isolated-store
```

## 宿主差异

- Codex Plugin 在 `hooks.json` 中内联调用 `lore hook codex`，并提供 PowerShell 的 `commandWindows` 变体与 `additionalContextLimit`。
- ZCode 不支持 `commandWindows` 与 `additionalContextLimit`；ZCode Plugin 通过 `${ZCODE_PLUGIN_ROOT}/hooks/run-hook.cmd` polyglot 包装脚本跨平台调用无扩展名的 `hooks/session-start`（`${ZCODE_PLUGIN_ROOT}` 是宿主原生变量，与 Claude 兼容变量在宿主内展开为同一插件根路径），后者包装 `lore hook zcode` 并在 CLI 缺失或非零退出时兜底输出 `{"continue":true}`。上下文预算由 CLI 渲染器的 4000 字符上限保证，与 codex 共享同一实现。
