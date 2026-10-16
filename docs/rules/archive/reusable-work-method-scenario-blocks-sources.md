# 可复用工作方法场景块：来源与维护附录

本文服务于方法审计、修订和追溯。日常任务调用请读取[可复用工作方法场景块](reusable-work-method-scenario-blocks.md)，无需加载本附录。

## 归纳口径

截至 2026-10-15，`docs/review` 约有 370 份评审材料，包含同一主题的多轮计划评审、代码复审和修复复核。数量不等于独立证据数量；本文是代表性抽样和仓库既有执行纪律的定性综合，并未对每份文档逐篇编码统计。

一个建议只有在具备代码依据、可复现结果、后续修复/关闭记录或跨主题重复出现时，才作为较稳定的方法纳入。场景块是工作法草案，不自动成为所有任务的硬门禁，应按风险裁剪。

## 场景块来源映射

### 1. 从故障现象到根因修复

- `run-shell-command-failure-diagnosis-and-remediation-plan-review.md`：提供了 `node_modules` 文本导致成功输出被失败文案替换的完整因果链，也识别了 signal 退出被误判的问题。证据支持本地代码路径及修复方向，不证明生产发生频率。
- `2026-10-03-main-code-review-v2.md`：通过注入忙时竞态和目录权限复现确认问题，展示了从具体现象构造可重复证据的方法。

### 2. 需求 / 技术方案准入评审

- `context-injection-refactor-plan-review-v2.md`：指出压缩触发计算口径冲突和事件缺少唯一提交点。
- `background-task-execution-layer-technical-design-v3-review.md`：识别 apply 崩溃恢复、进程身份、依赖物化、文件系统持久化和事务 outbox 缺口。
- `2026-10-11-wechat-confirmation-prompt-delivery-failure-code-review-v5.md`：复现微信恢复器消费其他渠道事件，说明所有权检查必须前置到查询/领取边界。
- `2026-10-01-main-divergence-hosted-runtime-integration-plan-review-v3.md`：区分本地提交与远端接受，要求完成条件覆盖用户真正目标。

其中部分结论属于静态方案评审，不能替代实现后的故障注入和真实平台验证。

### 3. 代码评审与增量复审

- `2026-10-15-im-security-review-improvement-rereview.md`：区分生产装配缺陷与过时测试夹具，并坚持保留原验收断言。
- `2026-10-14-17236274-aes-gcm-review.md`：区分代码解析错误、沙箱 `EPERM` 环境失败和真实 macOS 钥匙串验收边界。
- `2026-10-03-main-code-review-v2.md`：记录纯 HEAD 基线、评审范围和多项验证证据。

评审模板不能保证发现所有缺陷；领域风险仍需决定检查场景。

### 4. 测试设计与修复验收

- 仓库根 `AGENTS.md` 的“队列 / 票据 / 配额类模块不变量优先”要求：确定性伪随机操作序列逐步断言跨函数不变量。这是历史遗漏教训沉淀出的仓库工作约定。
- `2026-10-01-queued-task-bar-tdd-review-v5.md`：覆盖成功/失败响应乱序的边界。
- `2026-10-11-wechat-confirmation-prompt-delivery-failure-code-review-v5.md`：展示既有测试全绿仍可能漏掉跨渠道不变量。
- `2026-10-15-im-security-review-improvement-rereview.md`：展示测试夹具应符合正式规则装配契约。

实际命令和完整验收范围应遵循仓库当期脚本及任务约定。

### 5. 数据迁移、持久化与崩溃恢复

- `legacy-workspace-layout-cleanup-plan-review.md`：指出通用 update API 会篡改会话最近活动时间。
- `legacy-workspace-layout-cleanup-plan-review-v2.md`：指出跳过损坏数据仍永久标记完成会造成漏迁移。
- `background-task-execution-layer-technical-design-v3-review.md`：详述崩溃原子性、blob fsync 和 outbox 风险。
- `context-injection-refactor-plan-review-v2.md`：检查事件截断重放是否确定。

耐崩溃保证最终需在目标文件系统、数据库和平台上执行故障注入。

### 6. 安全授权与外部渠道边界

- `2026-10-11-wechat-confirmation-prompt-delivery-failure-code-review-v5.md`：识别跨渠道 wake 恢复污染，并明确真实微信引用标记未完成真机验收。
- `2026-10-15-im-security-review-improvement-rereview.md`：覆盖敏感正文终检、最终规则装配和测试夹具一致性。
- `remote-private-chat-security-code-review-2e399cd.md`：记录工具确认分类与超时收尾的一致性问题。

具体威胁模型依赖部署、平台和产品能力，场景块不能替代安全设计评审。

### 7. 阶段计划、范围控制与交付

- 仓库根 `AGENTS.md` 的“Agent 执行纪律”：开始前对齐验收边界、按阶段独立交付、按影响范围运行测试。
- `automated-test-suite-cleanup-audit-review-v2.md`：要求先修复阻断基线，再进入测试清理计划。
- `2026-10-01-main-divergence-hosted-runtime-integration-plan-review-v3.md`：区分阶段局部成果与最终推送目标。

## 维护规则

- 新增来源时，优先保留能证明方法的代表性文档，不追求穷举引用。
- 来源文档仅用于追溯；历史提交、测试数字或未完成状态不自动代表当前仓库状态。
- 若某条方法后续被新证据推翻，先更新日常场景块，再记录本附录中结论变化与证据。
- 日常调用优先加载主文档中命中的单个场景块；只有需要审计方法来源或更新长期知识时再读本附录。
