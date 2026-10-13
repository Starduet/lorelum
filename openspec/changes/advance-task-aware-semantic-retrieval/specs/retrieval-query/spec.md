# Spec Delta

## ADDED Requirements

### Requirement: Vector relevance uses multiple query clauses and Practice content views
semantic retrieval SHALL 以自然语言 query 的 clause views 与同一 Practice 的多个持久化内容视角之间的相似度决定默认排序。一个 Practice SHALL 提供三种表示组：`full`（不含 id 与字段标签的整条 Practice 文本，作为上下文锚点，并按估算 token 预算切分）、`task-card`（title、`applies_when`、stage、anti-pattern 等 schema 字段）、以及 `body`（自由 Markdown body 的带标题路径语义块）。默认 query 按跨语言标点边界拆成 clause views；当 query 没有可拆分 clause 时，该 clause 才等同完整原句。每种表示组都 SHALL 可以被单独编码和单独匹配，但 `full` MUST 不参与常规打分，只在没有其它可打分 view 时兜底。系统 MUST 先对每个 clause 分两段计算 Practice：`task-card` 取最佳适用性匹配，`body` 同时取最佳片段和全片段均值并按固定非负比例混合，保留局部片段证据而不让块数线性加分。每个 clause MUST 对全部 eligible Practice 产生一个 clause 分数，系统 MUST 在**同一次检索**里把这些 clause 分数聚合为一个 Practice 分数：按 query view 的基准权重求加权平均。单个背景/领域 clause 的高分 MUST NOT 独自带过整条 Practice，因为动作 clause 的余弦会被计入同一个平均值；系统 MUST NOT 额外叠加"最弱 clause"一类跨-clause 惩罚项，因为实测它同样压低"动作 clause 命中、背景 clause 很弱"的正确 Practice。排序 MUST 只发生一次，MUST NOT 引入跨轮 reciprocal rank fusion、单视图槽位轮、细化轮，或任何以名次替代向量余弦的多轮机制。两段计算 MUST 覆盖全部 eligible Practice，MUST NOT 用第一段截断候选池后再做第二段。系统 MUST NOT 把全部正文块分数直接相加，MUST NOT 使用负权重，也 MUST NOT 依赖 FTS5/BM25、词表切分或其它词面任务信号作为默认 semantic 排序主干。进入 embedding 的文本 MUST NOT 包含 Practice id、anti-pattern id 或字段标签，因为这些是伪装成向量的字面信号。`task-card` MUST NOT 包含 `tech_stack`，使领域名词不能单独决定适用性问题；`full` MAY 保留技术领域，作为上下文锚点。调用方 MUST 不必提交 `intent`、`stage`、`domain` 或任何其他结构化 query 字段。Practice 的 Markdown body MUST 继续按自由文本处理。

#### Scenario: A content view supplies the decisive match
- **WHEN** 一个完整 query 的语义与某 Practice 的 `body`、`task-card` 或 `full` 视角匹配，而另一个同领域 Practice 在文本上更通用
- **THEN** semantic retrieval SHALL 让匹配 Practice 的该 view 分数进入 Practice 级聚合，并且 MUST NOT 丢掉该命中

#### Scenario: Within-Practice combination never sums chunk scores
- **WHEN** 两个 Practice 的最佳局部 view 与同一 query 具有相同余弦分数，而其中一个 Practice 被切成更多 `body` views
- **THEN** 每个 query 视角在 Practice 内使用最佳片段与全片段均值的固定混合，Practice 级分数 MUST NOT 因 body view 数量更多而线性提高

#### Scenario: A local body fragment remains visible in m-side scoring
- **WHEN** 一个 Practice 的多个 body views 中只有一个片段与当前 clause 高度匹配，其余片段提供上下文或弱匹配
- **THEN** 该最佳片段 SHALL 通过 m-side 片段证据分量进入 Practice 分数，且 MUST 不因简单平均而被完全抹掉

#### Scenario: Full-corpus m-side scoring has no candidate funnel
- **WHEN** semantic query 对 eligible Practices 计算 task-card 与 body 片段证据
- **THEN** 两段 MUST 都在全部 eligible Practices 上执行，第一段 MUST NOT 截取候选池后才计算第二段；`K` MUST 只作用于最终排序后的结果

#### Scenario: Clause scores aggregate in a single retrieval pass
- **WHEN** default query 被拆成多个 clause view
- **THEN** 每个 clause MUST 对全部 eligible Practice 产生 clause 分数，且这些分数 MUST 在同一次检索里聚合成一个 Practice 分数；系统 MUST NOT 为每个 clause 生成独立排名再用 rank fusion 合并，也 MUST NOT 引入细化轮或单视图槽位轮

#### Scenario: A background-only clause cannot carry the whole Practice
- **WHEN** query 拆成多个 clause，一个 Practice 只在背景或领域 clause 上得分很高，而在动作 clause 上得分很低
- **THEN** 该背景 clause 的高分 MUST NOT 独自把 Practice 抬到前列；动作 clause 的近零余弦 MUST 按基准权重计入平均值，使 Practice 分数被稀释

#### Scenario: Scoring stays vector-only for languages without word boundaries
- **WHEN** query 与 Practice 文本属于不同语言，或彼此没有共同字符或 token
- **THEN** semantic retrieval MUST 仍按 embedding 相似度排序，且 MUST NOT 依赖任何字面匹配或分词结果；语义路径 MUST NOT 引用 keyword projection、keyword index 或其它词面 scorer

#### Scenario: A view never exceeds the model input budget
- **WHEN** Practice 正文由没有标点边界或没有空格的语言书写，或整条 Practice 文本很长
- **THEN** projection SHALL 按估算 token 预算而不是字符数切分 `full` 与 `body`，使每个 view 保持在模型输入预算内

#### Scenario: Semantic query never silently falls back to keyword
- **WHEN** embedding 或 semantic index 不可安全使用
- **THEN** semantic retrieval MUST 返回既有 typed failure 或非终态，且 MUST NOT 改用 keyword、BM25 或词面 fallback 伪造 semantic 结果

### Requirement: Ranking covers every eligible Practice before the result limit
semantic retrieval SHALL 对所有 eligible Practice 计算相似度聚合和排序，调用方请求的最终 `top-k` MUST 只在完整排序产生之后应用，MUST NOT 先把候选列表截断成更小的池再排序。同时只向调用方返回最多 `top-k` 个 canonical Practice summary，并且 MUST 不在既有结果 envelope 中暴露内部 score、候选来源、query 内容或 Practice 正文。benchmark harness 的候选宽度 MAY 限制它报告的 candidate ID 数量，但 MUST NOT 改变参与打分的 Practice 集合或最终排序。

#### Scenario: A lower raw candidate becomes the final match
- **WHEN** 调用方请求 `--top-k 1`，全量 eligible Practice 中包含一个仅全文相似的 Practice 和一个经 Practice 内多视角向量聚合后更相关的 Practice
- **THEN** 系统 SHALL 在完整排序后只返回后者的 canonical summary

#### Scenario: Candidate reporting does not shrink the scored set
- **WHEN** benchmark harness 用候选宽度 `N` 读取 candidate ID 列表
- **THEN** 打分和排序 MUST 仍覆盖全部 eligible Practice，`N` 只限制返回的 candidate ID 数量

#### Scenario: Final result remains bounded and private
- **WHEN** semantic retrieval 对全量 eligible Practice 成功完成
- **THEN** public result SHALL 至多包含请求数量的 Practice summary，且不新增内部排名诊断字段

### Requirement: Bounded lexical evidence preserves candidate observation
semantic retrieval SHALL 使用同一次 query attempt 的 canonical 内容计算辅助词面证据；MUST 在最终排序前完成所有候选的 canonical digest 校验，并按 reader 顺序保留内部候选观察名单。query 中的普通代词 MUST 不因技术复合词被拆分而获得匹配证据，近同分且有效匹配词数相同的候选 MUST 不因候选池极值归一化而获得最大幅度的加分差。部分匹配的唯一候选 MUST 不仅因为唯一命中而获得满额词面加分。计算已选排序所需的能力失败时 MUST 返回既有 typed query failure，不成功返回未声明的替代顺序。

#### Scenario: Reader order differs from final order
- **WHEN** 两个候选完成同一 snapshot 的 canonical 校验，且辅助排序改变它们的顺序
- **THEN** 内部 candidateIds SHALL 保持 reader 顺序，finalIds SHALL 使用最终顺序，且都只属于成功 attempt

#### Scenario: Technical compound is not a pronoun match
- **WHEN** 普通代词与 Practice 中技术复合词的某个拆分片段相同，而复合词本身没有被 query 提及
- **THEN** 系统 MUST 不把该片段作为当前任务的词面匹配，但明确请求该技术复合词时仍可匹配

#### Scenario: Weak partial match does not become full evidence
- **WHEN** 一个候选只匹配有效 query 的部分词，且它是唯一词面命中
- **THEN** 词面增强 SHALL 受有效匹配词证据约束，不得仅因候选池中没有其他命中而取满额

#### Scenario: Signal failure does not return a hidden alternative ranking
- **WHEN** 当前请求需要计算辅助词面信号，但排序所需的 FTS 能力不可用
- **THEN** query SHALL 返回既有 typed failure，内部 harness SHALL 不返回任何候选或最终名单

#### Scenario: Unmatched background does not dilute existing lexical evidence
- **WHEN** query 追加了一组对同一候选池的任何文档都不匹配的背景词，候选与原匹配保持不变
- **THEN** 既有候选的词面强度 SHALL 保持不变，而不因 query 变长被降低
