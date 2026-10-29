# 工具调用安全审核范围缓存执行计划

> 2026-10-29；方案真源：[工具调用安全审核性能调研.md](../工具调用安全审核性能调研.md)；实现基线 `990d1e2e`。本计划只登记编排与进度，验收和不变量以方案为准。

## 验收边界

- **本机源码关闭**：会话级内存缓存、工具对象识别、逐次策略/facts/permit 校验、Agent 范围批准、写入回执与脚本/可执行/固定 CI 排除、跨会话与跨 lane 隔离、撤销/容量/并发故障注入，以及相关安全测试、系统 invariant 检查、类型与构建验证。
- **外部验收，不阻塞源码关闭**：真实飞书/微信账号及生产通道回合、其他操作系统实际文件句柄与 rename 行为、正式安装包、真实生产审计日志前后对照。能在本机模拟的 lane、平台错误、并发替换均纳入本机测试。
- 缓存未满足全部本机边界时保持关闭并回退原策略。外部验收只影响发布/启用确认，不影响源码完成。

## 依赖 DAG

| 任务 | 动作与产物 | 目标文件/模块 | 完成证据与 RED/GREEN | 依赖 | 环境 / 状态 |
|---|---|---|---|---|---|
| P0 | 固定干净 worktree、锁文件依赖与基线；登记本计划 | 本计划、worktree、`package-lock.json` | `npm ci`；`npm run build:agent-provider-pi-ai`；`npm exec vitest run electron/confirmation/reviewScopeCache.test.ts electron/confirmation/approvalAgent.test.ts electron/confirmation/agentChannel.test.ts electron/confirmation/toolCallGate.test.ts`（249 passed） | — | 本机 / `- [x]` |
| P1 | 定义版本化对象范围、规范参数序列化、HMAC 摘要与有界会话缓存 | `electron/confirmation/reviewScopeCache.ts`、对应测试 | RED：模块缺失时导入失败；GREEN：摘要绑定、空/非法对象拒绝、回显校验、隔离、容量、回执与代次用例通过（7 tests） | P0 | 本机 / `- [x]` |
| P2 | 在共享策略中登记来源明确的缓存写入/消费规则与 trace | `src/shared/confirmation/types.ts`、`src/shared/policy/*` | RED：范围 grant 原先仍返回 require-confirm；GREEN：`npm exec vitest run src/shared/policy/policyEngine.test.ts src/shared/policy/policyDecision.test.ts src/shared/policy/defaultRules.contract.test.ts`（128 passed）+ `npm run typecheck:shared`；验证多个 ask、user override、human floor、来源许可、默认写边界和两个稳定 trace ID | P1 | 本机 / `- [x]` |
| P3 | 扩展审批答复与调用候选，使 Agent 可在一次审核中批准精确范围 | `src/shared/confirmation/types.ts`、`electron/confirmation/approvalAgent.ts`、审批 skill 与 prompt | RED：Agent 批准后原 outcome 不含范围 grant；GREEN：`npm exec vitest run electron/confirmation/approvalAgent.test.ts electron/confirmation/agentChannel.test.ts`（79 passed）覆盖旧答复/缺字段、非法摘要、拒绝、摘要不符；`npm run typecheck:shared` 与 `npm run build:electron:incremental` 通过。候选和明确复用选项在同一次审核中传递 | P1、P2 | 本机 / `- [x]` |
| P4 | 将缓存接入每次 gate；只对桌面及 IM 普通文件规则启用明确 Agent 来源例外，其余能力均 miss | `electron/confirmation/toolCallGate.ts`、facts/extractors、通道装配 | gate 集成 RED 覆盖同对象变文命中、不同对象/工具/lane/主体/只读任务未命中；策略 trace 与审核调用次数断言 | P2、P3 | 本机 / `- [ ]` |
| P5 | 增强受控原子写回执；首次写与缓存命中写均以句柄身份和内容证明激活/推进 | `electron/confirmation/directoryHandleWriter.ts`、`electron/tools/builtinExecutors.ts`、写 permit | 故障注入 RED 覆盖 rename/link 替换、原位改写、取消、提交不确定；无可信回执不得缓存或推进 | P1、P4 | 本机模拟 / `- [ ]` |
| P6 | 加入脚本/可执行/固定 CI 排除，撤销、清理、会话密钥销毁、代次与 LRU 容量语义 | `electron/confirmation/reviewScope*`、会话生命周期装配、路径分类 | 对应 AC 与随机状态序列不变量测试；所有失败只 miss/撤销，不绕过原审核 | P4、P5 | 本机 / `- [ ]` |
| P7 | 端到端策略矩阵、边界回归、关闭路径与源码最终验收 | 相关 electron/shared 测试及安全检查 | 定向测试、`check:system-invariant-registry`、类型检查、增量主进程构建、最终全量测试/构建；每阶段独立提交 | P1–P6 | 本机 / `- [ ]` |
| E1 | 对真实桌面、飞书、微信、自动任务日志对照审核调用数与延迟 | 外部运行记录 | 记录真实环境、样本与命中/回退原因；不作为源码开发门禁 | P7 | 外部 / `- [ ]` |
| E2 | 在 macOS/Windows 及正式安装包验证打开句柄提交能力和运行行为 | 外部平台验收记录 | 不支持句柄提交的平台确认缓存关闭；支持平台记录实测回执和安全边界 | P7 | 外部 / `- [ ]` |

## 执行纪律

- 每个 P 阶段按 RED → GREEN → 定向回归完成后单独提交；RED 必须是目标行为缺失造成的预期失败。
- 只运行本阶段相关测试；最终阶段再运行全量验收。外部 E 项不阻塞 P 项。
- 进度只更新本表状态和证据；方案规格仍以源方案为准。
