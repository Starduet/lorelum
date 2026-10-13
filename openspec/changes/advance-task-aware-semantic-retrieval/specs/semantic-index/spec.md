# Spec Delta

## MODIFIED Requirements

### Requirement: Build and rebuild preserve consistency
`lore index build` MUST 在 active index 已与当前 Store 和 Profile 一致时避免重复编码。Store 发生连续变更时，build SHALL 仅重新编码新增或 semantic view projection 改变的 views；未变化的 `full`、`task-card` 或 `body` views MAY 复用已验证 digest 的向量。删除或仅 metadata 改变的 record MUST 不要求 embedding。多视角表示、表示组划分、分块配方、view 身份或兼容规则发生变化时，固定 embedding Profile MUST 使旧 active index 不再被视为兼容；系统 MUST 在 staging index 完整校验后、受 Store snapshot fence 保护地建立完整且内部一致的新表示。历史缺失、index 不兼容或安全复用不能证明时，build MUST 回退到完整 snapshot 构建。`lore index rebuild` MUST 强制完整构建。所有构建 MUST 在 staging index 完整校验后，受 Store snapshot fence 保护地原子发布 active index；失败 MUST 保留原 active index。

#### Scenario: Ready index is a no-op
- **WHEN** `lore index build` 发现 active index 已完整覆盖当前 Store 且 Profile 兼容
- **THEN** 命令 SHALL 返回 ready index，且 MUST 不请求 document embedding

#### Scenario: Incremental update
- **WHEN** Store 的连续 revision history 可以安全覆盖 active index 之后的变更
- **THEN** build SHALL 只编码新增或 view projection 改变的内容视角，并原子发布更新后的 index

#### Scenario: Multi-view representation invalidates an older index
- **WHEN** active index 基于单全文向量、旧 view 种类（如 `applicability`/`topic`/`guidance`）或不包含当前 view recipe 的旧 Profile 建立
- **THEN** 系统 MUST 不将其报告为 compatible ready，并且后续 build MUST 通过完整、一致的当前 Profile 表示原子发布新 index

#### Scenario: Failed replacement leaves current index usable
- **WHEN** full 或 incremental 构建在 staging、embedding 或发布前失败
- **THEN** 系统 MUST 不把未完成 index 标记为 ready，且此前 active index MUST 保留
