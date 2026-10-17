# 需求写作指南：来源与维护附录

> **本文件服务于方法审计、修订与追溯。日常写作任务不需要加载本文**——读 [`requirement-writing-guide.md`](requirement-writing-guide.md) 正文即可。
> 分工见 [`document-writing-guide.md`](document-writing-guide.md) §1：正文只放动作；来源映射、抽样口径、例证完整版、局限与维护规则放在本文件。

## 归纳口径

截至 2026-10-16，`docs/review/` 中的 requirement 类评审共 **36 篇**，但只有约 **13 个独立主题**：

| 主题 | 篇数 |
|---|---|
| `mcp-tool-call-card-display-requirement` | 14（v1–v14） |
| `explicit-output-directory-candidate-requirement` | 4（主评审 + 第 2/3/4 轮） |
| `macos-api-key-access-authorization-requirement` | 3 |
| `mcp-integration-requirement`、`artifact-decision-remote-im-requirement`、`2026-10-08-remote-im-async-approval-security-requirement`、`llm-model-baseline-integration-requirement`、`agents-md-workdir-instructions-requirement` | 各 2 |
| `read-file-tail-and-oversized-tool-result`、`builtin-subagent`、`file-viewer-markdown-export-docx-pdf`、`remote-private-chat-security-optimization`、`2026-10-14-run-shell-justification` | 各 1 |

**篇数不等于独立证据数量。** 精读 12 篇（覆盖四类形态：主评审、多轮复审、短评审、迭代收尾）：`explicit-output …-requirement-review` 及其 second / third / fourth、`agents-md-workdir-instructions-requirement-review`、`read-file-tail-and-oversized-tool-result-requirement-review`、`remote-private-chat-security-optimization-requirement-review`、`mcp-tool-call-card-display-requirement-review-v13`、`builtin-subagent-requirement-review`、`artifact-decision-remote-im-requirement-review` 及其 second-review、`2026-10-08-remote-im-async-approval-security-requirement-review`、`file-viewer-markdown-export-docx-pdf-requirement-review`。

**主题命中统计**（正则近似命中，仅用于判断分布，不等于问题数量）：

| 主题 | 命中篇数 / 36 |
|---|---|
| 需求与既有能力/现状冲突（冲突、违反、现状写错） | 17 |
| 验收与 AC 相关（AC-、验收标准、用例） | 16 |
| 不可判定 / 不可实现 / 无法验证 | 6 |
| 成功指标 / 阈值 / 可观测 / 统计口径 | 5 |
| 非目标 / 范围收敛 / MVP / 收敛顺序 | 4 |

纳入标准同技术方案篇：具备代码依据、可复现结果、后续修复 / 关闭记录，或跨主题重复出现。

## 修订记录（2026-10-16）

通用规则（读者分层、写作流程、人类决策层 R1–R6、通用自检）原寄居在《技术方案写作指南》，正文以"第 1 篇"简称引用；本轮已迁入元指南 [`document-writing-guide.md`](document-writing-guide.md) §8–§11，正文引用同步改为"元指南 §x"。迁移理由与口径见 [`document-writing-guide-sources.md`](document-writing-guide-sources.md)。

**同日第三轮（界面加戏案例）**：正文新增两处——① §4 的**新增界面触发线**（出现界面语义即须出界面归属卡，交项目负责人批）；② §5 的**"推荐默认值"禁用清单**（界面 / 开关 / 数据格式 / 对外接口 / 外部渠道行为不得以推荐值承载）。附录自检补第 8 条。来源见 [`interaction-design-guide-sources.md`](interaction-design-guide-sources.md) 的"I8 的来源"与 [`document-writing-guide-sources.md`](document-writing-guide-sources.md) 案例 15。

## 正文各节的来源映射

- **§0-1 价值先行** ← 使用者实践总结（本原则的首要来源）；间接评审证据：需求评审的结论段普遍先判定"核心问题是否成立"，如 `explicit-output …-requirement-review` §1（先确认"需求要解决的核心问题是成立的"，再指出范围过大）；`remote-private-chat-security-optimization-requirement-review` §0 总评（先评价叙事与目标定位，再谈残留问题）；`explicit-output …-requirement-review` §5 要求按**用户价值**排 MVP 收敛顺序，而不是按实现难度。
- **§1 人机协同、§2 读者分层**：`explicit-output …-requirement-second-review`（"这些问题不需要提前做架构设计，但**必须在需求中明确用户会看到什么、任务是否会被打断以及系统最终写到哪里**"）；`…-requirement-fourth-review`（"三种体验的打断时机、保留预期和后续清理行为都不同，**不能留给技术设计自行选择**"）；36 篇的主题分布本身（需求侧缺失集中在价值、体验、询问策略，而非机制）。
- **§3 流程（差异步骤）**：第 1 步现状 ← `mcp-tool-call-card-display-requirement-review-v13`（把既有文件名"现状"写错、与现有脱敏链路冲突）；第 2 步行为模型 ← `explicit-output …-requirement-review` P0-1/P0-2；第 4 步反例 ← 同文 P0-5 与 `…-fourth-review`；第 6 步范围 ← 见上条"§5 范围与开放决策"。
- **§4 交互内容**：判据已抽取为独立的《交互设计指南》（I1–I5）；来源映射与迁移记录见 [`interaction-design-guide-sources.md`](interaction-design-guide-sources.md)。需求侧只检查交互取值是否引用该指南，并写明本需求的取值（正文 §4）。
- **§5 范围与开放决策** ← `explicit-output …-requirement-review` §1 与 §5（范围横跨六块；给出按用户价值的 MVP 收敛顺序）；`read-file-tail-and-oversized-tool-result-requirement-review` P0-1（非目标把唯一的出站门闩排除在本期之外，与目标互相抵消）；`mcp-tool-call-card-display-requirement-review-v14` Critical 2（本期已要求实现的 IPC 被描述成"未来再引入"）；`remote-private-chat-security-optimization-requirement-review` §2.1（开放决策须在设计前选定）。
- **§6 验收与指标** ← `explicit-output …-requirement-review` §4（30 条 AC 仍缺 10 项；"显著下降/足够低/一次操作内/不高于基线"无法用于上线判断，要求先定义可观测事件、分母、阈值）；`mcp-tool-call-card-display-requirement-review-v13` Critical 5（要求的 `truncated: true` 在类型层面不可返回）；`builtin-subagent-requirement-review`（缺 Run 级终态契约 → 验收不知该断言什么）；`agents-md-workdir-instructions-requirement-review` B02（"重启恢复"未区分历史只读还原与可执行恢复 → 验收歧义）。
- **§7 跨文档一致性** ← `remote-private-chat-security-optimization-requirement-review` §2.5（需求已宣告废止前置 G5，但前置文档尚未改字，"规格分叉会在评审/实现间复燃"）与 §6.5、§3 第 1 条（文档同步列为交付物；身份地基与减确认须"同版本可验收"）。
- **§8 反模式表** ← 上述各条的归并；完整症状集合见下节。

## 附：正文 §8「反模式 → 对应步骤」表的完整版

正文每行只留一个最能对上号的症状；下列为完整症状集合，供追溯或反驳时引用。

| 反模式 | 精简前的其余症状 |
|---|---|
| 需求与既有能力冲突 | `mcp v13`：需求称"模型投影不脱敏"，而现有链路经 `serializeAgentToolResult` 本就是 Agent-safe 投影（按需求实现＝安全回退）；同一章节既称写入器"需补 UTF-8 安全截断"又称其"已使用 UTF-8 安全边界"；`agents-md-workdir` B01：要求"已运行调用绑定原目录"，未定义与既有 `switch_work_dir` 的关系；`llm-model-baseline` 第 1 项：迁移判据会覆盖用户手改的内置模型参数 |
| 验收不可判定 / 不可实现 | `explicit-output`：AC 缺口 10 项、指标无法判定；`mcp v13` Critical 5：失败分支按定义没有该字段；`builtin-subagent`：`end_turn` 等模型级停止原因不能表达 Run 级结果；`agents-md-workdir` B02：历史还原与可执行恢复混为一谈，实施者可能被迫扩展 SDK 能力 |
| 规则冲突无裁决顺序 | `explicit-output`：显式路径优先 vs 材料必须在固定目录下；"仓库内交付文档算项目变更还是工作包"口径不明；事实上的第四类容器保留/清理预期不明 |
| 触发条件过宽 / 留白 | `explicit-output` 第 2 轮："有影响就问"→ 逐文件询问；第 1 轮：Git 提示"首次"未定义周期 → 可能每会话重复打断 |
| 范围与非目标 | `read-file-tail`：§3.2 非目标排除唯一出站门闩；`mcp v14`：本期交付被写成未来方案；`explicit-output` §5：按用户价值排 MVP 顺序 |
| 用户可感知后果缺失 | `explicit-output`：持续写作被反复打断；取消规则留下"用户无法理解的半成品状态"；默认目录结构对简单交付偏重 |
| 留白被当成实现细节 | `explicit-output` 第 4 轮：同一请求三种打断时机，交由设计决定即为缺陷 |

## 局限

1. 规则来自单项目抽样；36 篇中 14 篇是同一主题的多轮迭代，"触发条件过宽"实际只有一个主题来源（但跨 4 轮反复出现，属稳定复现的问题）。
2. 依据强度不均：价值先行、验收口径与跨文档一致性有评审证据；原交互类判据（R7–R11）已迁出至《交互设计指南》，其依据强度见 [`interaction-design-guide-sources.md`](interaction-design-guide-sources.md)。
3. 未做"外行读者"实测（同技术方案篇），"人类层四问"的完整性尚无跨文档统计。
4. 本指南不替代安全与合规评审；它约束"怎么写清楚"，不保证"需求本身正确"。

## 维护规则

1. 新增规则前，先确认它**挂得到元指南 §9 的某一步，或元指南 §10 的某条 R**（需求特有规则则挂到本指南 §3 的某一步）；挂不上的多半是症状描述，应删而不是收。
2. 新增规则时在本文件补来源映射与依据强度；来源文档中的历史提交号、行号与未完成状态不自动代表当前仓库状态。
3. 需求侧若出现与元指南 §8–§11 冲突的写法，先判断是"需求特有"还是"通用规则写错"，再决定改哪一篇——**通用规则只在一处定义（元指南）**。
4. 规则被新证据推翻时，先更新正文，再在本文件记录结论变化与证据。
