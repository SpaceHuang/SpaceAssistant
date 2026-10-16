# 执行计划写作指南：来源与维护附录

> **本文件服务于方法审计、修订与追溯。日常写作任务不需要加载本文** —— 读 [`execution-plan-writing-guide.md`](execution-plan-writing-guide.md) 正文即可。
> 分工见 [`document-writing-guide.md`](document-writing-guide.md) §1：正文只放动作；来源映射、口径、迁移记录、局限与维护规则放在本文件。

## 迁移记录（2026-10-16）

- **正文**自 [`technical-plan-writing-guide.md`](technical-plan-writing-guide.md) 的 §5「执行计划写作标准」拆出：原 5.1–5.6 → 现 §1–§6（按元指南 §5-1 **重新编号**，原位置留指针）。
- **本文件的依据条目**自 [`technical-plan-writing-guide-sources.md`](technical-plan-writing-guide-sources.md) 的「§5（执行计划）的依据」迁出，原处留指针（元指南 §5-1）。
- 拆分的实验依据与元指南缺口清单：实验记录 `technical-plan-v2-draft-comparison.md`（已随实验结束删除；结论已并入元指南 §4.3、§5、§6-6 与本文件）。

## 归纳口径

证据同样来自 `docs/review/` 约 370 份评审材料的抽样（口径与精读清单见技术方案指南的 sources）。本指南对应的是**执行计划类**评审：同一主题常有多轮（如 `background-mission-phase0` 12 轮、`main-blocking` 18 轮），**篇数不等于独立证据数**。

## 各条来源映射（按拆出前的小节号对照）

- **§1 与方案篇的分工（原 5.1）** ← [`explicit-output-directory-candidate-technical-design-review`](../review/explicit-output-directory-candidate-technical-design-review.md)（阶段一声称完成 AC-01~AC-15，其中 4 条依赖阶段二才实现的能力）；"验收与不变量的真源在方案"承接技术方案指南 §4 的验收写法。
- **§2 任务粒度（原 5.2）** ← [`2026-10-11-im-security-review-improvement-todo-review`](../review/2026-10-11-im-security-review-improvement-todo-review.md) C3（使用可独立验收的交付单元，避免机械拆分或单项过宽："不能仅以一个 GREEN 编号视作已足够细"）及其 [v2](../review/2026-10-11-im-security-review-improvement-todo-review-v2.md) N2（拆分后未同步修订验收范围，第一个 GREEN 不可能通过）；[`renderer-process-jank-optimization-plan-review-v29`](../review/renderer-process-jank-optimization-plan-review-v29.md)（跨阶段 API 依赖导致两阶段都无法独立验收）。
- **§3 顺序与依赖（原 5.3）** ← todo-review 及其 v2（回退晚于启用、真实链路验收早于实现依赖、阶段检查点要求后置证据、环境与基线准备）；[`2026-10-15-security-policy-three-stage-architecture-development-plan-review`](../review/2026-10-15-security-policy-three-stage-architecture-development-plan-review.md) 及 v2/v3（DAG 自环与验收自环、依赖表与正文不一致"无法确定哪份是权威"、外部资源前置、阶段门禁与仓库纪律冲突）；[`renderer-process-jank-optimization-plan-review-v8`](../review/renderer-process-jank-optimization-plan-review-v8.md)（阶段可独立验收的要素）；[`explicit-output-directory-candidate-technical-design-review`](../review/explicit-output-directory-candidate-technical-design-review.md)（阶段声明的 AC 依赖后一阶段）。
- **§4 任务登记与完成判据（原 5.4）** ← todo-review C2（RED/GREEN 需定义任务级完成标准；目标文件、测试名、命令、通过标准应登记）及其 [v3](../review/2026-10-11-im-security-review-improvement-todo-review-v3.md)（实施前的登记仍须落实）；todo-review C4（依赖就绪判据与基线失败分流）。
- **§5 状态标记规范（原 5.5）** ← [`artifact-decision-remote-im-tdd-implementation-review-v2`](../review/artifact-decision-remote-im-tdd-implementation-review-v2.md)（计划中 284 项全为 `- [ ]`，没有任何 `- [~]` 或 `- [x]`）。
- **§6 自检（原 5.6）** ← 上述各条判据的汇总。
- **两条来自实际执行观察**（未绑定评审文档）：① 前置门禁要求后序阶段完成的工作；② 把当前机器无法执行的任务设为开发前置门禁（如在 macOS 环境下要求先拿到 Windows 的性能测试数据）。

## 局限

1. 规则来自单项目抽样；上述"两条执行观察"没有可绑定的评审文档。
2. 尚缺跨多个计划的实测（下一个真实计划写作时正好验证）。
3. 不替代仓库既定的测试 / 门禁纪律（见 `AGENTS.md`「测试」与「Agent 执行纪律」）。

## 维护规则

1. 新增反模式前，先确认它**挂得到正文某一步**（元指南 §3-2）。
2. 新增规则时，在本文件补来源映射与依据强度。
3. 与方案篇或其它指南冲突时，先判"层归属错误"还是"规则写错"，再决定改哪一篇（元指南 §6-2）。
4. 规则被新证据推翻时，先改正文，再在本文件记录结论变化与证据（元指南 §5-4）。
