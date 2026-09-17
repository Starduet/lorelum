## Context

见 [proposal.md](./proposal.md) 的问题说明。当前 marketplace 和 Plugin 都命名为
`lorelum`，因此 Codex 的 plugin cache 落在 `cache/lorelum/lorelum/<version>/...`。宿主把
Skill root 以 alias 表示、再提供相对 `file:` 路径时，连续同名层会放大 Agent 漏读一层的风险。

已确认的现状如下：

- `.agents/plugins/marketplace.json` 的 marketplace 名和唯一 Plugin entry 都是 `lorelum`。
- `plugins/codex/lorelum/.codex-plugin/plugin.json` 的 Plugin ID 是 `lorelum`；其 host-specific
  source root 已由后续 `standardize-host-plugin-layout` 变更统一。
- `plugins/codex/lorelum/scripts/marketplace-config.test.ts` 锁定 marketplace namespace、Plugin
  ID、显示名与当前 source root 的映射。

## Goals / Non-Goals

**Goals:**

- 让 marketplace namespace 与可安装 Plugin identity 在配置、selector 和缓存路径中可区分。
- 保留用户面对的产品身份：Plugin ID `lorelum`、显示名 **Lorelum**；host-specific source root
  由 `standardize-host-plugin-layout` 管理。
- 在 alpha 阶段一次性完成迁移，结束后只有一个有效的 Lorelum marketplace source。
- 保持 CLI-first Skill/Hook 边界、`lore hook codex` ABI 和 Pack 检索行为不变。

**Non-Goals:**

- 不承诺改变 Codex 如何生成 `rN` root alias 或其 plugin cache 布局；那是宿主行为，也不通过
  额外的 Skill 路径提示改变其行为。
- 不保留 `lorelum@lorelum` 的并行兼容 source，也不为此引入别名 Plugin、自动配置迁移或本地
  MCP。
- 不重命名 `lorelum` Plugin，也不改变已发布 CLI 的版本或合同。source root 的迁移由后续
  `standardize-host-plugin-layout` 负责，不在本 change 中另立路径合同。

## Decisions

### 1. 用 `lorelum-plugins` 表示分发层，保留 `lorelum` 表示可安装 Plugin

**Proposed:** marketplace metadata 的 `name` 改为 `lorelum-plugins`；Plugin manifest 的
`name` 保持 `lorelum`。新 selector 为：

```text
lorelum@lorelum-plugins
```

对应的宿主缓存层级将把分发来源和 Plugin 明确分开：

```text
cache/lorelum-plugins/lorelum/<version>/skills/lorelum/SKILL.md
```

这不把 cache path 变成 Lorelum 的产品合同；它只是移除当前公开 identity 造成的重复视觉信号。

**Why this over renaming the Plugin:** `lorelum` 是用户安装、看到和识别的产品对象。保留它可以避免
重写 Plugin manifest ID；host-specific package 命名可以在不改变公开身份的前提下独立演进。marketplace
是分发 namespace，`lorelum-plugins` 能准确表达它的责任。

### 2. 采用一次性 alpha migration，不维护旧 selector

**Proposed:** 文档提供明确的手动迁移序列：移除旧 Plugin/source，添加更新后的 public
marketplace，再安装新 selector。迁移完成的判定是 `codex plugin marketplace list` 只显示一个
Lorelum source，`codex plugin list` 只显示 `lorelum@lorelum-plugins`。

这比让旧、新 marketplace 同时存在更安全：两个 source 都能提供同一个 `lorelum` Plugin ID，会
重新引入 source 选择歧义，正是本次配置漂移暴露的问题。

### 3. 将公开 selector 作为分发合同测试，而非仅靠文档同步

**Proposed:** 扩展当前 Codex artifact 的 `marketplace-config.test.ts`，同时验证：

- marketplace 名是 `lorelum-plugins`；
- 唯一 Plugin entry、Plugin manifest ID 和当前 host-specific source root 保持对应；
- 组装出的 selector 是 `lorelum@lorelum-plugins`。

安装文档、升级命令、checkout-backed development flow 和中英文站点页使用相同 selector。这样每次
Plugin 分发变更都会被定向测试覆盖，而不是依赖人工全局搜索。

### Alternatives considered

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 保持 `lorelum@lorelum`，仅保留额外 Skill 提示 | 不选 | 用户要求不以额外提示修补宿主路径呈现；两个身份仍在宿主呈现中完全同名。 |
| marketplace 保持 `lorelum`，Plugin 改为 `lorelum-codex` | 不选 | 会移动 Plugin 的公开身份和 manifest；用户面对的安装对象变得更长，迁移面更大。 |
| marketplace 改为 `lorelum-plugins`，Plugin 保持 `lorelum` | 推荐 | 以最小迁移面区分分发层与产品 Plugin，同时保留用户可见的产品名。 |
| 同时保留旧、新 selector | 不选 | 两个 marketplace source 可解析到同一个 Plugin ID，制造新的 source 歧义。 |

## Risks / Trade-offs

- [已有 alpha 安装命令失效] → 在所有安装、更新和开发文档提供同一段迁移命令；发布前用干净 Codex
  配置按文档演练。
- [用户保留旧 source] → 文档以旧 source 的移除为新安装前置条件；验证要求检查只有一个 Lorelum
  marketplace。
- [用户仍将 alias 误当路径] → 不把 marketplace 改名描述成对宿主路径解析的完全保证；该 alias 的
  解析仍由宿主负责。
- [本地开发 cachebuster 与公开版本混淆] → cachebuster 仍只用于本地迭代，提交前还原 manifest 的正式
  版本；文档区分 public marketplace 与 checkout-backed source。

## Migration Plan

1. 更新 marketplace metadata、分发 delta spec、分发测试和全部面向用户/维护者的 selector 文档。
2. 在干净的 Codex config 中演练以下公开迁移路径，并记录命令输出：

   ```sh
   codex plugin remove lorelum@lorelum
   codex plugin marketplace remove lorelum
   codex plugin marketplace add lorelum/lorelum
   codex plugin add lorelum@lorelum-plugins
   ```

3. 验证 marketplace 和 Plugin 状态、安装缓存中 distinct namespace 的路径，以及新 task 是否加载 Skill
   与 Hook。
4. 在 alpha release notes 中标明这是 breaking distribution migration，并给出上述恢复路径。

**Rollback:** 若新 marketplace metadata 不能被 Codex 解析，恢复上一版公开 marketplace metadata，并让
用户重新添加 legacy `lorelum` source 与 `lorelum@lorelum`。不得在同一配置中同时添加两套 source。

## Open Questions

- Codex host 是否会把 `lorelum-plugins` 原样用作其 cache root，需在实现时以一个干净配置实际安装
  验证；即使宿主选择不同的内部 cache 名，公开 selector 和唯一 source 的合同不变。
