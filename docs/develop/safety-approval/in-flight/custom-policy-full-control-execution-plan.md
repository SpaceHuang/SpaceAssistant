# 自定义安全策略完整可配置执行计划

- **日期：** 2026-10-22
- **状态：** Phase 0–4 已关闭；Phase 5 源码集成与回滚验收进行中；T10 外部验收未开始
- **方案真源：** [自定义安全策略完整可配置开发计划](./custom-policy-full-control-development-plan.md)
- **验收与不变量真源：** 方案 INV-01–INV-10；产品行为 AC-1–AC-22 以需求稿为准
- **代码基线：** `109a938404124235d632e4cdbd4f9e06eaa48728`

本轮执行记录（2026-10-23）：T0 逐条盘点 101 条规则并核验 writer/consumer/批准后续路径；T1b 对照基线 `109a9384` 记录 UI 范围（追溯记录，时间偏晚已注明）。Phase 0 收尾 5 文件 / 178 项通过；Phase 1 收尾 19 文件 / 347 项通过（含 deniedTools 不可绕过与同级 ask 稳定选择）；Phase 2 收尾 9 文件 / 89 项通过，包含旧 toggle 兼容 shim 的 allow/reset 两条路径，以及 shared/renderer 类型检查。Phase 3 合并集合 15 文件 / 471 项通过；另有 Desktop Hosted policy-change 用例 1 项通过，`typecheck:shared` 与 Electron incremental build 通过。Phase 4 renderer 合并用例 21 项通过，i18n normal/strict 与 renderer typecheck 通过；Impeccable detector 返回 `[]`。Phase 5 T8 已删除旧 rule-enabled shim，并完成 AC/INV 矩阵；跨域集合 40 文件 / 802 项通过。Strict i18n 报出的 1714 条均位于测试文件（符合仓库例外），源码为 0。T9 回滚证据与最终全仓验收进行中；T10 外部验收未开始。

本轮计划评审（2026-10-22）处理：B1 全规则覆盖及消费点、B4 T4/T7/T8 的兼容接口顺序；B2/B3/B5 分别在 T6/T5/T4 按最小范围补充。负责人确认 ingress 消息须经批准后才进入处理，exposure 对象须经批准后才暴露；这是本期必做能力，见需求 AC-21/AC-22。

> 本文只维护任务状态、依赖和执行证据。需求行为、阶段边界与回退语义不在本文另行定义。状态只用 `- [ ]` 未开始、`- [～]` 进行中、`- [x]` 有证据完成。

## 当前环境验收边界

**当前机器可完成并可作为源码阶段门禁：** 定向 Vitest、Electron/renderer/shared 类型检查、增量 Electron 构建、i18n 检查、数据库 transaction harness、授权版本/派发屏障测试、executor spy、迁移 fixture 与回滚演练。

**需外部环境验收，不阻塞源码阶段：** Electron 桌面窗口手工操作；真实微信/飞书 owner 账号和异步审批待办；存量用户数据库副本升级/重启/回退；发布支持平台的正式包启动与布局。外部环境缺失时，源码可关闭，发布/启用验收保持待完成。

## 任务依赖表（唯一 DAG 真源）

| 任务 | 直接依赖 | AC / INV 关联 |
|---|---|---|
| T0 基线盘点与变更前测绘 | — | 所有 AC；F-01–F-11 |
| T1a 界面归属卡批准记录 | — | D-UI；AC-1、AC-7–AC-9、AC-19 |
| T1b 方案期视觉基线 | T0 | D-UI；AC-1、AC-7–AC-9、AC-19 |
| T2 全规则动作域与覆盖合同 | T0 | AC-1–AC-6；INV-01、INV-02 |
| T3 invocation/ingress/exposure 策略消费 | T2 | AC-1–AC-6、AC-10–AC-12、AC-21–AC-22；INV-01–INV-03 |
| T4 Desktop/IM 旧停用迁移与兼容写入契约 | T3 | AC-7–AC-10、AC-19–AC-20；INV-04、INV-07 |
| T5 策略 revision 与待审批失效接线 | T4 | AC-13–AC-14、AC-18–AC-20；INV-05、INV-07 |
| T6 执行器派发线性化与 stale policy 拦截 | T3、T5 | AC-15–AC-18；INV-05、INV-06 |
| T7 设置 UI 与 i18n | T1a、T1b、T2、T3、T4、T5、T6 | AC-1、AC-7–AC-9、AC-19、AC-21–AC-22；INV-08 |
| T8 删除旧 rule-enabled 兼容接口并完成集成矩阵 | T3、T4、T6、T7 | AC-1–AC-22；INV-01–INV-10 |
| T9 回滚演练与源码关闭 | T8 | 全部 AC/INV 的关闭证据 |
| T10 外部桌面/IM/存量库验收与启用 | T9 | 外部验收记录；AC-7–AC-18 真实体验确认 |

T0 与 T1a 可并行，T1b 在 T0 完成后开展；T1b 只作为 T7 的 UI 实施前置，不属于 Phase 0 关闭门槛，也不阻塞 T2–T6。当前 worktree 接手时 T7 UI 已经落地，故 T1b 以基线 diff 追溯记录并标明时间偏差。各 Phase 按序关闭并提交后进入下一 Phase；T1b 可在这些阶段推进时并行完成。任务依赖表是唯一顺序真源，Phase 内可按依赖并行；T4 在 T3 后，T7 在 T5/T6 后，T8 在 T7 完成后才移除兼容 API，避免阶段交付之间出现未适配调用方。

阶段标题用于归类任务，任务启动顺序只由上方 DAG 决定。T1a 的界面归属卡批准已完成；T1b 已补记 source baseline 对照与本次范围检查。D-UI 于 2026-10-22 获项目负责人批准：保持现有设置界面和布局不变，只开放原来锁定规则的动作配置。

## 阶段与任务

### Phase 0：源码基线与界面准入

**阶段输入：** 需求 AC-1–AC-22、方案 F-01–F-11、源码基线。**阶段产出：** 可复核的规则/消费者矩阵和变更前定向测试结果。**允许改动：** 仅方案证据记录；不修改代码。**失败回退：** 对照源码修订未确认的事实，不改运行数据。

- [x] **T0 · 盘点规则集合、状态写入者和调用派发路径**
  - **目标文件/模块：** `src/shared/policy/defaultRules.ts`、`policyPackages.ts`、`policyEngine.ts`、`electron/confirmation/policyRulesRuntime.ts`、`policyRuleStore.ts`、`imPolicyStore.ts`、`electron/ipc/{securityIpc,policyIpc}.ts`、`toolCallGate.ts`、`agentSdkSafetyPolicy.ts`、`agentSdkTurnDispatch.ts`、`invocationAssembler.ts`、`packages/agent-sdk/src/{executionAdmission,toolExecutionPort}.ts`、`ToolsSecuritySettingsTab.tsx` 与邻接测试。
  - **产物：** 全量矩阵（规则 ID × lane × when: invocation/ingress/exposure × 默认/当前动作 × locked/disabled/humanRequired × UI 行 × writer × 消费者 × 测试），并标出批准对象、批准后的继续位置、迁移源、API caller 与派发路径。
  - **完成判据：** 设置页每一展示规则均有动作域、实际消费点和消费者测试落点；入口 ask 对应待处理消息对象，exposure ask 对应工具/能力对象；所有 enabled/disabled、policy write、批准/resume/claim 调用均有证据；记录实际源码基线偏移。
  - **验证：** `rg -n "id:|locked:|humanRequired|confirm-every-time|when:" src/shared/policy/defaultRules.ts`；`rg -n "decideIngress|exposure|disabledRuleIds|securitySetRuleEnabled|rule-enabled|rule-override" electron src/shared src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`；`rg -n "beginDispatch|currentAuthorizationVersion|subscribeAuthorizationChange|deferredResume" electron packages/agent-sdk/src`；阅读对应实现与测试，不以搜索命中直接定性。
  - **环境 / 状态：** 本机 / 已完成；全规则逐条 matrix 与调用链核验已记录。


#### T0 源码规则与消费矩阵（2026-10-23）

矩阵依据 `defaultRules.ts` 全部规则对象、`settingsSecurityModel.toRuleViews`、设置页 `rulesForLane` 及实际 writer/consumer 实现建立。表中“默认动作”是源规则值；实际当前动作由所选 package/profile 和持久化 rule override 决定。工作树没有应用运行中的 `spaceassistant-data.db`，因此无法把某个用户当前的持久化动作或 legacy disabled list membership 误记为源码默认值。旧 `disabledRuleIds` 来源为 desktop legacy config 与 IM policy snapshot；迁移后不再作为运行时决策输入。

表中 source line 以当前 worktree 读取的规则定义为准；“current action source”描述运行时求值链，具体结果由当前 package 与 override 决定；逐用户 legacy disabled membership 因本机运行数据库不在该 worktree 中，不能凭源码判定。每条 invocation 规则的消费点和测试落点逐条列出。`所有匹配 lane` 表示 rule 没有静态 lane 限制，由 match 条件及调用 lane 决定；automation 规则由任务权限/调用者数据驱动，不开放设置页编辑。

| Rule ID | Source line | Lanes | When | Default action | Current action source | Locked | humanRequired | Legacy disabled state | UI row | Writer | Consumer | Test family |
|---|---:|---|---|---|---|---|---|---|---|---|---|---|
| `wiki-raw-write-deny` | 20 | all matching | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outside-write-deny` | 27 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-outside-standard-review` | 34 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-outside-strict-human` | 39 | desktop | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-outside-loose-review` | 44 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-mode-loose-allow` | 49 | desktop, wechat, feishu | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-mode-standard-review` | 54 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-mode-strict-human` | 59 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-sensitive-standard-human` | 64 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-sensitive-strict-human` | 69 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-sensitive-loose-review` | 74 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-strict-human` | 79 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-review` | 84 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-standard-review` | 89 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-loose-review` | 94 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-write-scope-unknown-deny` | 99 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outside-read-deny` | 106 | wechat, feishu, automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-wechat-media-outside-deny` | 113 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-wechat-media-unknown-deny` | 120 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-target-unsupported-deny` | 127 | all matching | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `feishu-media-boundary-deny` | 133 | feishu, automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `feishu-media-boundary-unknown-deny` | 140 | feishu, automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-sensitive-workdir-switch-deny` | 147 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-unknown-workdir-switch-deny` | 154 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-network-deny-remote` | 161 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-dangerous-deny` | 170 | all matching | invocation | deny | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-deny-lark-write-outbound` | 180 | feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-deny-wechat-outbound` | 190 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-browser-disabled` | 202 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-shell-disabled` | 212 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outbound-budget-pause-wechat` | 223 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outbound-budget-pause-lark` | 233 | feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `shell-sensitive-path-confirm` | 243 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `shell-system-dir-confirm` | 250 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-script-path-unknown-deny` | 257 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-script-permission-missing-deny` | 264 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-unverified-script-language-deny` | 271 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-sensitive-path-deny` | 278 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-system-dir-deny` | 284 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-write-deny` | 290 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-deny` | 296 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-sensitive-path-confirm` | 302 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-system-dir-confirm` | 308 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-path-unknown-confirm` | 314 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-path-unclassified-confirm` | 320 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-dynamic-execution-confirm` | 326 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-suspicious-path-unknown-confirm` | 332 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-declared-path-scope-allow-desktop` | 338 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-unmodeled-path-ask` | 346 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-unverified-language-confirm` | 352 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `shell-precheck-auto-allow` | 367 | desktop | invocation | auto-evaluator | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `path-sensitive-read-confirm` | 376 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `path-system-dir-ask` | 384 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `read-target-workdir-allow` | 393 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `path-outside-readonly-allow` | 400 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-network-ask-desktop` | 408 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-uncertified-ask-remote` | 417 | wechat, feishu | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-clean-certified-remote` | 427 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-clean-allow-desktop` | 437 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-danger-ask` | 448 | all matching | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-browser-act-danger-human` | 456 | wechat, feishu | invocation | ask | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-allow-unconfigured` | 467 | desktop, wechat, feishu | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-ask-remote` | 477 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-browser-act-review` | 487 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-ask-desktop` | 496 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-navigate-ask-remote` | 506 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-navigate-ask-desktop` | 518 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-message-group-human` | 530 | feishu | invocation | ask | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-message-target-unknown-human` | 540 | feishu | invocation | ask | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-high-impact-ask` | 550 | desktop, feishu | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-unknown-ask` | 559 | desktop, feishu | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-write-ask` | 568 | desktop, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-lark-low-write-review` | 577 | feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-lark-message-self-review` | 586 | feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-lark-message-direct-review` | 595 | feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-read-allow` | 604 | desktop, feishu | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `toolkit-read-allow` | 615 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-time-query-review` | 622 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `toolkit-act-ask` | 630 | desktop | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `mcp-account-unauthorized-deny` | 646 | all matching | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-mcp-permission-missing-deny` | 655 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `mcp-readonly-allow` | 664 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-mcp-public-read-review` | 671 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `mcp-tool-ask` | 680 | all matching | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-low-risk-create` | 688 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-low-risk-edit` | 696 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-write-sensitive-path-confirm` | 705 | wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-write-ask` | 712 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-bound-output-write-allow` | 724 | automation | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-grep-permission-missing-deny` | 731 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-readonly-allow` | 738 | automation | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-unsupported-deny` | 759 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-analysis-incomplete-deny` | 768 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-path-facts-incomplete-deny` | 775 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-outside-root-deny` | 782 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-outside-risk-deny` | 789 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-authorized-shell-allow` | 796 | automation | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-default-confirm` | 807 | automation | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-no-wechat-send` | 818 | wechat, feishu | exposure | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `resolveExposure` | `exposure/toolsConfigRuntime/effectiveTools` |
| `ingress-direct-other-deny` | 829 | wechat, feishu | ingress | deny | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `decideIngress` | `ingress/imInboundGuard/remote caller` |
| `ingress-feishu-group-deny` | 837 | feishu | ingress | deny | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `decideIngress` | `ingress/imInboundGuard/remote caller` |

**跨行状态与对象核验：**

- 设置页展示来自 `settingsSecurityModel.ts:50` 的 `toRuleViews`；desktop 与 wechat 两个视图均通过 `ToolsSecuritySettingsTab.tsx:325` 的 `resolvePolicyRules` 派生。IM 的 wechat/feishu 共用一个 `policy_behavior_snapshots(domain='im')` revision；desktop action override 写入 `policyRulesRuntime.ts` 管理的 desktop package，IPC 经 `policyIpc.ts` 强制 expectedRevision。测试：`policyRulesRuntime.test.ts`、`imPolicyStore.test.ts`、`policyIpc.test.ts`、`ToolsSecuritySettingsTab.test.tsx`。
- Invocation facts 与 policy 决策由 `toolCallGate.ts` → `agentSdkSafetyPolicy.ts` 消费；Hosted SDK 再由 `agentSdkTurnDispatch.ts`、`invocationAssembler.ts`、`registeredAgentTurnTools.ts` 绑定调用、计划、facts 与 permit。批准继续位置为 prepare/recheck，再进入 `SafetyGate.authorize` 与 `toolExecutionPort`。测试：`agentSdkSafetyPolicy.test.ts`、`agentSdkTurnDispatch.test.ts`、`invocationAssembler.test.ts`、Hosted/IM caller integration suites。
- Ingress 对象是尚未处理的原始消息。`decideIngress` 由 `imInboundGuard.ts` 生产判定，ask 由 `imIngressApprovalPrompt.ts` 绑定原 channel/identity/message/envelope；只在批准后把同一条消息送入远程路由。测试：`ingress.test.ts`、`imIngressApprovalPrompt.test.ts`、`imInboundGuard.test.ts`、微信/飞书 remote-agent suites。
- Exposure 对象是单个工具/能力。`resolveExposure` 由 `exposure.ts` 求值，`toolsConfigRuntime.ts` 和 `effectiveTools.ts` 只在 deny/ask 解决后生成可见能力；ask 批准绑定工具身份后继续构建工具清单。测试：`exposure.test.ts`、`toolsConfigRuntime.test.ts`、`effectiveTools.test.ts`。
- 全部旧动作写入与派发入口检索已逐个阅读复核：`securitySetRuleEnabled`/`rule-enabled` 只保留迁移期兼容边界，本阶段尚未执行 T8 清除；rule action write 由 desktop/IM domain writer 接收；审批和 deferred/resume 由 confirmation adapter、`deferredResumeCoordinator.ts` 与一次性 resume request store 承接；permit claim/final dispatch 由 `executionAdmission.ts`、`toolExecutionPort.ts` 及 Electron coordinator 共同完成。
- **T0 基线验证：** policy runtime、IPC、policy engine、入口/暴露消费者、设置 UI、Hosted SDK 与 caller 定向测试均可启动；该测试运行发生在当前实现已落入 worktree 后，不能冒充改动前基线。源码规则按上表全量逐条盘点，批准对象、继续位置、迁移源、writer 和派发路径均有对应实现/测试证据。

- [x] **T1a · 记录界面归属卡批准**
  - **目标范围：** 本方案第 0 层已批准的界面归属卡；仅记录批准，不改代码。
  - **产物：** 项目负责人于 2026-10-22 的明确批准记录。
  - **完成判据：** 五行卡无待定项；范围明确为现有设置界面和布局不变，只开放原锁定规则动作配置；不新增入口、页签、页面或独立面板。
  - **验证：** 复读开发方案批准记录。
  - **证据：** 用户明确回复“批准上方界面归属卡：确认批准”，并澄清“现有设置界面不变，原来写死不可设置的，现在可以设置”。
  - **环境 / 状态：** 本机 / 已完成；完成 D-UI。

- [x] **T1b · 建立方案期视觉基线**
  - **目标范围：** `ToolsSecuritySettingsTab.tsx`、相关设置页主题与组件约定；只读核对。
  - **产物：** 现有布局/控件证据和 `$impeccable` 方案期有范围检查记录。
  - **完成判据：** 记录本轮只改规则动作控件及必要说明，不重新设计页面；实现后检查只覆盖批准范围。
  - **验证：** 对照组件源码与主题 token，保存检查结论供 T7 引用。
  - **证据：** 对照基线 `109a9384` 的 `ToolsSecuritySettingsTab.tsx` 与当前实现，原有设置 Tab、表格列、LANE tabs、Ant Design 控件与 token/CSS 结构保留；变化只涉及 custom 行动作选择、保存 pending/success/conflict 反馈和必要说明，未新增页面、分区或改变布局。规则动作沿用原表格 action 列和 `Config` 组件约定。UI 完成后执行 `$impeccable` manual detector：`detect.mjs --json ...ToolsSecuritySettingsTab.tsx ...ToolsSecuritySettingsTab.test.tsx ...config.json` 返回 `[]`。该 source baseline 比代码实现晚记录；这是本 worktree 接手时的既存实现，已以基线 diff 复核并如实登记。
  - **环境 / 状态：** 本机 / 已完成（追溯对照）；T7 UI 实施前置已具备范围与视觉证据。

- [x] **Phase 0 关闭门槛**
  - **证据来源：** T0 规则/消费者核验表与检索记录；T1a 批准记录。动作矩阵和多规则需求以需求 AC 为准。
  - **完成判据：** T0 全部展示规则及消费路径闭合；D-UI 批准记录可查；基线定向测试能启动且既有失败已登记，不把外部账号/窗口验收设为开发门禁。T1b 在 T0 后完成，且只作为 T7 的前置；T2–T6 不依赖 T1b。
  - **阶段收尾证据：** `./node_modules/.bin/vitest run src/shared/policy/policyPackages.test.ts src/shared/policy/policyEngine.test.ts electron/confirmation/policyRulesRuntime.test.ts electron/ipc/policyIpc.test.ts src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx` — 5 files / 178 tests passed。该检查在实现已存在的 worktree 上执行，不视作改动前基线。T0 的 101 条规则矩阵及批准对象/继续位置/writer/测试映射已记录；T1a 批准证据已复核；T1b 已对照代码基线与当前 UI 范围。

### Phase 1：规则动作和引擎语义

**阶段输入：** Phase 0 盘点；T2→T3。**阶段产出：** 规则覆盖校验开放且多规则结果固定。**允许改动：** shared policy/types、engine/runtime resolver、ingress/exposure 消费点与实际调用方、相关审批 adapter 及对应测试；不迁移持久化 disabled 数据。**移除兼容：** 本阶段暂不删除 `disabledRuleIds`，保证尚未迁移的用户状态仍有效。**失败回退：** 回退 Phase 1 policy changes，旧 persistence 与 IPC 保持原行为。

- [x] **T2 · 为全部展示规则开放 lane 动作校验并固定覆盖解析**
  - **目标文件：** `src/shared/confirmation/types.ts`、`src/shared/policy/policyPackages.ts`、`src/shared/policy/laneProfiles.test.ts`、`policyPackages.test.ts`、`policyPackages.recovery.test.ts`、`policyPackages.scope.test.ts`、`defaultRules.contract.test.ts`；`src/shared/policy/policyFloor.ts`、`electron/confirmation/toolCallGate.ts` 与 floor tests 按决策合同一并修改。
  - **产物：** action × lane × when × policy rule 合同测试；locked rule 可覆盖/重置；`confirm-every-time` 映射；显式覆盖移除同规则默认门控测试。
  - **完成判据：** 设置页每条 desktop 规则支持四动作，每条 IM 规则支持三动作，包括 invocation、ingress、exposure；未知规则、错误 lane、非法动作仍拒绝；`automation` 仍不可用户配置；`locked`、`humanRequired`、默认 floor 不拒绝显式用户动作；保留规则身份/匹配结构校验及 automation 当前 floor；子调用 floor 不扩大父调用当前用户策略。该任务只验动作合同，消费者语义在 T3。
  - **验证命令：** `npm exec vitest run src/shared/policy/laneProfiles.test.ts src/shared/policy/policyPackages.test.ts src/shared/policy/policyPackages.recovery.test.ts src/shared/policy/policyPackages.scope.test.ts src/shared/policy/defaultRules.contract.test.ts electron/confirmation/policyFloor.test.ts electron/confirmation/policyRulesRuntime.test.ts`。
  - **环境 / 状态：** 本机 / 未开始；完成 AC-1、AC-2–AC-6 的动作域部分，INV-01、INV-02。

- [x] **T3 · 在 invocation、ingress、exposure 消费点落实动作语义**
  - **目标文件：** `src/shared/policy/policyEngine.ts`/decision tests；`electron/confirmation/ingress.ts` 与入口 caller；`electron/confirmation/exposure.ts`、`electron/toolsConfigRuntime.ts`、`electron/effectiveTools.ts` 与暴露 caller；相关审批 adapter、trace 和 caller tests。
  - **产物：** invocation 全命中动作集合及 trace；ingress ask 的待处理消息批准与批准后继续；exposure ask 的工具/能力对象批准与批准后暴露；各 when 至少一条真实消费者测试。
  - **完成判据：** invocation 任意规则排列结果相同并符合 deny > ask > auto > allow；入口 deny 阻断进入、allow 继续；ask 经人工批准才继续原消息；exposure deny 不暴露、allow 正常暴露、ask 经人工批准才暴露目标；旧审批/授权不得跨对象批准；缓存/自动审核不越过优先级。入口与暴露两类 ask 均须实现并通过需求 AC-21/AC-22。
  - **验证命令：** `npm exec vitest run src/shared/policy/policyEngine.test.ts src/shared/policy/policyDecision.test.ts src/shared/policy/memoryEligibility.test.ts src/shared/policy/imPolicyBehaviorResolvers.test.ts electron/confirmation/policyFloor.test.ts electron/confirmation/ingress.test.ts electron/confirmation/exposure.test.ts electron/toolsConfigRuntime.test.ts electron/effectiveTools.test.ts`。
  - **环境 / 状态：** 本机 / 未开始；完成 AC-1–AC-6、AC-10–AC-12、AC-21–AC-22，INV-01–INV-03。

- [x] **Phase 1 关闭门槛**
  - **证据来源：** T2 与 T3 的测试/决策 trace 断言；若改 `src/shared/confirmation/types.ts`，同时提供 `npm run typecheck:shared` 输出。
  - **完成判据：** T2/T3 测试通过；旧停用数据仍按兼容路径工作（T4 尚未启动）；每种展示规则类型的动作均有消费测试；automation 未意外开放。
  - **阶段收尾证据：** `vitest run` Phase 1 合并集合 19 files / 347 tests passed；覆盖 policy action/lane contract、多规则优先级、ingress ask 的原消息对象、exposure ask 的精确工具对象，以及 automation floor。代码和阶段状态随本提交关闭。

### Phase 2：持久化、IPC 与存量迁移

**阶段输入：** Phase 1 shared contract；T4。**阶段产出：** desktop/IM 都以动作覆盖表达配置，存量旧停用状态幂等迁移。**允许改动：** stores/runtime、IPC、迁移与边界测试；T7 前暂时保留旧 renderer API 合同。**移除兼容：** 去除 runtime disabled filtering；旧 API 改为短期兼容 shim，直到 T7 迁移 caller、T8 才删除。**失败回退：** 事务/迁移失败保留旧数据；回滚时连同 shim 版本一起恢复。

- [x] **T4 · 迁移旧停用规则并收敛 desktop/IM 写入合同**
  - **目标文件：** `electron/confirmation/policyRulesRuntime.ts`、`policyRuleStore.ts`、`imPolicyStore.ts`、policy migration 模块、`electron/ipc/securityIpc.ts`、`policyIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`；对应 stores、IPC、renderer caller 与迁移 tests。旧 preload/API 保留兼容映射。
  - **产物：** 按域迁移函数、旧数据 fixture、revision 写入契约、兼容 shim 和调用方契约测试、审计语义测试。
  - **完成判据：** desktop/IM disabled IDs 同迁移为 `allow` override 并在同一提交清除；重复运行幂等，冲突覆盖不丢失；事务失败回滚；reset 恢复默认；runtime 不再读取 disabled 状态；旧 `securitySetRuleEnabled`/`rule-enabled` 调用仍有有效 handler，暂映射为旧 disabled→allow、旧 enabled→reset default 的兼容语义；新 action API 强制 expectedRevision；旧 toggle shim 在主进程读取当前 revision 并用同一写入路径提交，保证旧 caller 有效，T7 迁移后由 T8 删除 shim。兼容 caller contract tests 覆盖旧界面动作写入与恢复默认两种路径，确认新 API 的 expectedRevision 要求不影响尚未迁移调用；策略保存成功由持久化提交决定，异步审计失败不得反向报告保存失败。审计正常路径记录 before/after 与迁移来源，不含正文。
  - **验证命令：** `npm exec vitest run electron/confirmation/policyRulesRuntime.test.ts electron/confirmation/policyRuleStore.test.ts electron/confirmation/imPolicyStore.test.ts electron/ipc/policyIpc.test.ts electron/appIpc.securityRules.test.ts src/shared/policy/legacyPolicyMigration.test.ts src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx`；并执行 renderer typecheck，确认兼容 shim 阶段旧 UI 的动作写入与恢复默认均可用。
  - **阶段证据：** 定向集合 9 files / 89 tests passed；shared 与 renderer typecheck 通过。迁移覆盖旧 desktop config 与 IM snapshot 的 disabled→allow 原子迁移、已存在 override、重复启动/回滚与未知状态；旧 preload/API shim 在 T4/T7 留存，测试了 disabled→allow、enabled→reset default。
  - **环境 / 状态：** 本机 / 已完成；完成 AC-7–AC-10、AC-19–AC-20，INV-04、INV-07。

- [x] **Phase 2 关闭门槛**
  - **证据来源：** T4 migration fixtures（旧桌面配置、旧 IM snapshot、已存在 override、部分失败、重复启动）；transaction rollback 与 revision conflict 测试。
  - **完成判据：** 每种来源数据迁移后唯一动作状态确定；迁移失败不删除旧值、不写部分快照；所有 runtime 不再读 disabled ID 作为策略动作；未知字段不导致忽略整个有效 snapshot。
  - **阶段收尾证据：** T4 定向集与 migration/startup fixtures 通过；旧 desktop disabled API shim 在计划窗口内维持可用，持久化写入已改为动作覆盖，runtime 不再以 disabled ID 决策。Phase 2 源码与状态随本阶段提交关闭。

### Phase 3：策略版本与执行派发边界

**阶段输入：** Phase 2 revision-aware writes；T5→T6。**阶段产出：** 策略变化时旧待审批结果失效并由现有调用路径重入 gate；执行器进入边界拒绝过期策略。**允许改动：** safety policy、deferred resume coordinator/caller、registered tools/runtime assembler 与 lifecycle tests。**失败回退：** revision 不可判定时不沿用旧授权；回退时沿用当前授权撤销路径。

- [x] **T5 · 使审批、审核及已批准待执行调用绑定策略 revision**
  - **目标文件：** `electron/confirmation/imPolicyStore.ts`、`deferredTodoStore.ts`、`deferredResumeRequestStore.ts`、`electron/remote/deferredResumeCoordinator.ts`、`deferredApprovalAdapter.ts`、`agentSdkSafetyPolicy.ts`、`agentSdkTurnDispatch.ts`、`electron/runtime/invocationAssembler.ts`、必要的 desktop epoch/change publisher 与对应 tests。
  - **产物：** desktop epoch 与 IM revision/epoch；审批对象绑定策略域/revision/调用事实；明确由 `deferredResumeCoordinator`（IM deferred）及 T0 盘点出的对应 desktop caller 接收策略变化并重入 gate；新 gate 结果替换旧等待状态。
  - **完成判据：** 等待人工批准或自动审核时保存策略，旧结果不可恢复；正常运行中原调用由具体变化通知接收者重新送入 facts/policy gate：新动作 deny 收束调用，allow/direct 进入后续派发，ask 创建新的审批，auto 使用新策略审核；原请求标识与一次性 resume 防止同一调用重复 dispatch；迟到旧批准稳定返回 stale；不新增本期未要求的持久化恢复队列；桌面/IM 域不串扰；嵌套 floor 由最新父策略重建。
  - **验证命令：** `npm exec vitest run electron/confirmation/imPolicyStore.test.ts electron/confirmation/deferredTodoStore.test.ts electron/confirmation/deferredResumeRequestStore.test.ts electron/remote/deferredResumeCoordinator.test.ts electron/confirmation/deferredApprovalAdapter.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/policyFloor.test.ts electron/tools/agentSdkTurnDispatch.test.ts`。
  - **阶段证据：** 合并集合覆盖 revision 变化后的 gate 重入、ask/allow/deny 新结果、迟到批准与单次 resume；IM deferred coordinator 及 Desktop Hosted caller 均有边界测试。
  - **环境 / 状态：** 本机 / 已完成；完成 AC-13、AC-14、AC-18、AC-19，INV-05、INV-07。

- [x] **T6 · 覆盖 claim 后到 executor 进入前的策略变化窗口**
  - **目标文件：** `packages/agent-sdk/src/executionAdmission.ts`、`toolExecutionPort.ts`、`electron/tools/registeredAgentTurnTools.ts`、`permitBoundCoordinatorDispatch.ts`、`electron/runtime/invocationAssembler.ts`、remote/desktop caller adapters 及相应 caller tests。
  - **产物：** 现有 revision/失效通知在 `onDispatchClaimed` 异步窗口后的最终检查位置；两种顺序的 barrier tests 与 executor spy。
  - **完成判据：** `claim` 后暂停 `onDispatchClaimed`，保存新策略再恢复时，executor 零调用且调用返回 T5 gate/recheck；executor 已进入后保存时不伪称撤销；异步 validatePrepared 窗口同样检查当前 revision；无 revision 或检查失败不使用旧授权。不得把 claim 当作 executor 已开始；final-check 只核验批准对象、permit、材料与版本，不重新计算业务风险。若实现引入锁/等待，记录实际锁持有边界并确保锁内不等待审批、长执行或回调。
  - **验证命令：** `npm exec vitest run packages/agent-sdk/test/executionAdmission.test.ts packages/agent-sdk/test/toolExecutionPort.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/policyFloor.test.ts electron/tools/permitBoundCoordinatorDispatch.test.ts electron/tools/registeredAgentTurnTools.test.ts electron/runtime/hostedAgentTurnHost.test.ts`；屏障测试断言保存与派发两种顺序均可完成。
  - **阶段证据：** claim/`onDispatchClaimed` 与 validatePrepared 异步屏障用例断言策略失效时 executor 不进入；executor 已进入后的 Hosted policy-change 用例验证只中断运行，不报告未派发。
  - **环境 / 状态：** 本机 / 已完成；完成 AC-15–AC-18，INV-05、INV-06。

- [x] **Phase 3 关闭门槛**
  - **证据来源：** T5 revision invalidation tests；T6 barriers 与 executor spy；每个生产 caller 的 caller-level test 证据。
  - **完成判据：** T5 证明策略变化通知可驱动原调用重新过 gate；T6 证明 claim 后异步窗口出现策略变化时旧 executor 不进入；desktop Hosted、direct registered tools、IM synchronous、IM deferred/resume 实际入口均覆盖。无锁实现不要求假想死锁测试；若实现引入锁，则按实际持有范围验证。
  - **阶段收尾证据：** T5/T6 合并集合 15 files / 471 tests passed；Desktop Hosted policy-change 回归 1 项通过；`typecheck:shared` 通过；`npm run build:electron:incremental` 通过。Phase 3 源码与阶段状态随本阶段提交关闭。

### Phase 4：设置 UI 与本地化

**阶段输入：** D-UI 已批准，T1b 视觉基线、Phase 1 action contract、Phase 2 新 write API；T7。**阶段产出：** 自定义规则可编辑和可保存；renderer 使用新 action API。**允许改动：** `ToolsSecuritySettingsTab.tsx`、settings model/IPC payload、i18n 与 renderer tests。**移除兼容：** UI 旧启停控件与旧 payload/key；旧 IPC/API shim 保留到 T8。**失败回退：** 可回退 UI，T4 shim 仍支持旧调用。入口与暴露 ask 均为本期必做能力；按需求 AC-21/AC-22 实现并验收。

- [x] **T7 · 改造规则行、IM 共享提示和保存反馈**
  - **目标文件：** `src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`、`toolsSecurityFormat.ts`（如 view formatting 所需）、`ToolsSecuritySettingsTab.test.tsx`、`src/renderer/i18n/resources/{zh-CN,en-US}/config.json`、`src/renderer/i18n/types.ts`。
  - **产物：** 规则 action selector、逐条 reset、默认人工批准频率说明、旧停用迁移说明、IM shared-domain notice、pending/success/failure/conflict UI、语言同步。
  - **完成判据：** 每条规则（含 ingress/exposure）动作集合准确；不出现 locked 只读行或启停开关；成功后才更新显示；revision 冲突重新读取；所有文案经 `t()`；实现后 `$impeccable` 检查完成。自动化/静态检查作为本机门禁；真实 Electron 窗口窄布局手工结果记录为外部验收 T10，不阻塞源码阶段。
  - **验证命令：** `npm exec vitest run src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx`；`npm run i18n:generate-types`；`npm run i18n:check`；`npm run typecheck:renderer`。
  - **阶段证据：** renderer 组件 21 tests passed；`i18n:generate-types` 已运行；`i18n:check`、`i18n:check:strict`、renderer typecheck 通过；Impeccable detector 返回 `[]`。未改现有页面布局；桌面真实窗口窄布局归 T10。
  - **环境 / 状态：** 本机自动化 / 已完成；完成 AC-1、AC-7–AC-9、AC-19，INV-08。真实窗口检查归 T10。

- [x] **Phase 4 关闭门槛**
  - **证据来源：** T7 renderer tests、i18n check、typecheck、I8 card approval、`$impeccable` 检查记录。
  - **完成判据：** 桌面/IM action options 与主进程 validator 一致；共享配置说明明确；失败/冲突不误报；zh-CN/en-US keys 完整对齐；未经批准的界面改动为零。
  - **阶段收尾证据：** renderer 测试、i18n normal/strict、renderer typecheck 通过；当前 Impeccable 检查无 finding。Phase 4 UI/i18n 与阶段状态随本阶段提交关闭。

### Phase 5：集成、回滚与源码关闭

**阶段输入：** Phase 1–4 产物；T8→T9。**阶段产出：** 完整 AC/INV 映射、关闭证据、可执行回滚步骤。**允许改动：** 测试夹具、缺陷修复、文档证据与范围内代码；不新增产品行为。**移除兼容：** 删除 T8 已核验迁移的旧 rule-enabled shim 与剩余临时标记。**失败回退：** 源码可恢复；迁移数据按已演练步骤恢复。

- [x] **T8 · 移除旧接口并完成 AC × INV × 测试与安全审计矩阵**
  - **目标文件：** 所有阶段相关 tests；方案验收映射；必要的 `src/shared/security/systemInvariantRegistry.ts`/boundary tests（仅当代码核查证明新增了真正不可配置系统 invariant）。
  - **产物：** 删除 `securitySetRuleEnabled`/`rule-enabled` shim 的变更与静态搜索记录；AC-1–AC-22 → 用例名 → 命令 → invocation/ingress/exposure、dispatch/audit evidence 矩阵；外部项单列。
  - **完成判据：** T7 已迁移所有 renderer caller；删除共享 API、preload、handler、旧 payload 后本任务可独立通过类型检查和相关测试；AC-1–AC-22 有可达证据（含真实 ingress/exposure ask 消费者），每个 INV 有边界测试；审计不落正文/secret；不以 registry 锁定普通策略。
  - **验证命令：** `rg -n "securitySetRuleEnabled|rule-enabled|set-rule-enabled" electron src` 确认无生产引用；运行相关定向测试、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run check:system-invariant-registry`；涉及 agent-sdk 协议时补 `npm run check:agent-sdk`。
  - **环境 / 状态：** 本机 / 已完成；RED：旧接口不存在断言在 handler/API 仍存在时失败；GREEN：移除 `securityIpc` handler、preload 暴露与 shared API 类型后通过。`vitest run electron/ipc/securityIpc.policy.test.ts electron/appIpc.securityRules.test.ts electron/ipc/policyIpc.test.ts` 3 files / 18 tests；集成集合 40 files / 802 tests；`typecheck:renderer`、`typecheck:shared`、`check:system-invariant-registry`、`check:agent-sdk`、`build:electron:incremental`、`i18n:check`、`i18n:check:strict` 均通过。`rg -n 'securitySetRuleEnabled|rule-enabled|set-rule-enabled' electron src packages --glob '!**/*.test.*'` 无生产引用。AC/INV 证据见下表；Impeccable 静态 detector 为 `[]`。

#### AC 与测试证据映射

自动化用例标题可在所列文件中检索；本次合并门禁 `npm exec vitest run <相关文件>` 共 40 files / 802 tests。

| 需求 | 可复核用例与证据文件 |
|---|---|
| AC-1 | `laneProfiles.test.ts` 全规则/所有 lane 动作矩阵；`policyPackages.test.ts` 校验；`ToolsSecuritySettingsTab.test.tsx` 动作选项 |
| AC-2 | `policyEngine.test.ts` 显式 allow 清除同规则 locked、humanRequired、confirm-every-time 门控 |
| AC-3 | `policyEngine.test.ts` 用户动作优先于旧 human gate；`policyPackages.test.ts` 显式覆盖解析 |
| AC-4 | `policyEngine.test.ts` 显式动作遵循旧逐次确认语义；`agentSdkSafetyPolicy.test.ts` gate re-entry |
| AC-5 | `policyPackages.test.ts` locked invocation/ingress/exposure 可显式覆盖并剥离旧门控 |
| AC-6 | `policyEngine.test.ts` 显式 deny 与组合裁决；`policyIpc.test.ts` deny 写入 |
| AC-7 | `legacyImConfigBoundary.startup.test.ts` disabled→allow、原子清除与来源 marker；`ToolsSecuritySettingsTab.test.tsx` 迁移标签 |
| AC-8 | `policyIpc.test.ts`、`securityIpc.policy.test.ts` reset；UI reset 测试 |
| AC-9 | `policyPackages.test.ts`、`policyRulesRuntime.test.ts`、`policyIpc.test.ts` 套餐与覆盖保存/读取 |
| AC-10 | `policyEngine.test.ts` deny > ask > auto > allow 混合裁决与排列稳定性 |
| AC-11 | `policyEngine.test.ts` allow 与 ask 混合命中及 ask 胜出 |
| AC-12 | `policyEngine.test.ts` ask 与 auto 混合命中及优先级 |
| AC-13 | `agentSdkSafetyPolicy.test.ts` 策略变化后旧批准失效并重新进入 gate |
| AC-14 | `packages/agent-sdk/test/turn.test.ts` 最终复核转 ask；`remote/deferredResumeCoordinator.test.ts` stale todo |
| AC-15 | `packages/agent-sdk/test/executionAdmission.test.ts` admission 版本核验与未进入执行边界 |
| AC-16 | `packages/agent-sdk/test/toolExecutionPort.test.ts` dispatch port 授权终检 |
| AC-17 | `permitBoundCoordinatorDispatch.test.ts` prepared/claim 间版本漂移时 executor 零调用 |
| AC-18 | `permitBoundCoordinatorDispatch.test.ts` permit consume 后 claim barrier 与 executor 已进入边界；Hosted policy-change 测试 |
| AC-19 | `policyIpc.test.ts` revision conflict；`appIpc.securityRules.test.ts` expectedRevision；UI 冲突刷新且不误报成功 |
| AC-20 | `settingsAudit.test.ts` before/after；`imPolicyStore.test.ts` revision/audit 原子性；`securityAuditLog.test.ts` 敏感值脱敏 |
| AC-21 | `ingress.test.ts` ask 批准前阻止处理；`imIngressApprovalPrompt.test.ts` 一次性原消息批准；`imInboundGuard.test.ts` deny/allow/ask |
| AC-22 | `exposure.test.ts` ask 批准前不暴露、批准后暴露；`toolsConfigRuntime.test.ts`、`effectiveTools.test.ts` |

#### 不变量与边界测试映射

| 不变量 | 边界证据 |
|---|---|
| INV-01 全规则×lane×动作并接真实消费者 | `laneProfiles.test.ts`、`policyIpc.test.ts`、`ingress.test.ts`、`exposure.test.ts` |
| INV-02 每条规则只有用户最终动作来源 | `policyPackages.test.ts`、`policyEngine.test.ts`、`agentSdkSafetyPolicy.test.ts` |
| INV-03 唯一稳定优先级与胜出规则 | `policyEngine.test.ts` 多规则组合/排列用例 |
| INV-04 旧 disabled 迁移为普通 allow 且可幂等恢复 | `legacyImConfigBoundary.startup.test.ts`、`policyRulesRuntime.test.ts`、`policyPackages.test.ts` |
| INV-05 策略 revision 变化使旧审批失效 | `imPolicyStore.test.ts`、`agentSdkSafetyPolicy.test.ts`、`deferredResumeCoordinator.test.ts` |
| INV-06 final-check 只核验 permit/revision | `executionAdmission.test.ts`、`toolExecutionPort.test.ts`、`permitBoundCoordinatorDispatch.test.ts` |
| INV-07 snapshot/revision/epoch/失效/audit 同事务 | `imPolicyStore.test.ts`、`policyIpc.test.ts`；Desktop writer 测试验证 revision 与审计元数据 |
| INV-08 设置模型与 runtime 使用同一动作来源 | `settingsSecurityModel.test.ts`、`policyRulesRuntime.test.ts`、`ToolsSecuritySettingsTab.test.tsx` |
| INV-09 审计不含消息正文或敏感参数 | `securityAuditLog.test.ts`、`settingsAudit.test.ts` |
| INV-10 嵌套调用 floor 取父调用最新有效动作 | `agentSdkSafetyPolicy.test.ts`、`turn.test.ts` 父策略重建/重判用例 |

- [～] **T9 · 演练数据迁移、事务失败与版本回滚并关闭源码阶段**
  - **目标文件：** `imPolicyStore.test.ts`、`policyRulesRuntime.test.ts`、迁移 tests、相关计划/结果记录。
  - **产物：** 旧 disabled fixtures 升级前后快照；迁移重复运行、事务中断、部分 invalid legacy IDs、并发 policy write conflict、代码回退前 pending permit invalidation 记录。
  - **完成判据：** 测试证明迁移前规则集与旧 disabled list 可恢复；迁移提交不可出现覆盖与 disabled 两种状态并存；失败迁移保留原始数据；回退步骤先停止 writer、失效 pending permit、恢复一致快照；阶段相关全量测试和全仓 `npm test` 只在阶段收尾/最终验收执行；必要 build/typecheck/i18n 门禁通过。
  - **验证命令：** migration/recovery 定向测试；阶段最终 `npm test`；`npm run build:electron:incremental`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`；`git diff --check`。
  - **环境 / 状态：** 本机 / 验收中。`legacyImConfigBoundary.startup.test.ts` 验证未知 ID 或 snapshot 持久化失败时旧 disabled 原值仍可读；成功迁移用例验证 allow override 与 disabled list 同事务切换。`imPolicyStore.test.ts` 验证 audit/持久化失败整体回滚，以及恢复经校验的历史快照会递增 revision/epoch、撤销旧 authorization 并失效 pending todo/resume request，dispatching 项不伪称取消；revision 冲突不覆盖胜者。继续执行阶段收尾全仓测试、完整 build 和类型/i18n 门禁后关闭。本次为隔离 SQLite fixture 演练，不代表真实存量数据库/发布包验收，后者保留在 T10。

- [ ] **Phase 5 关闭门槛**
  - **证据来源：** T8 的 AC/INV 矩阵，T9 的迁移/回滚演练，Phase 0–4 测试结果。
  - **完成判据：** AC-1–AC-22 无未归属项；所有当前可运行门禁通过；任何环境缺失项标为外部待验收，不作已通过表述；回滚证据早于任何启用/发布动作。

### Phase 6：外部验收与启用

**阶段输入：** T9 源码关闭；D-UI 批准；可用测试机器、备份数据库副本与真实 IM 测试账号。**阶段产出：** 手工/外部渠道记录、启用决定。**允许改动：** 发现问题后回到对应任务修复并重新验收；不绕过 AC。**失败回退：** 停止发布或关闭新功能入口；保留数据备份和审计；不得恢复旧代码并让新格式数据裸跑。

- [ ] **T10 · 验收桌面、IM 账号、存量升级和发布包**
  - **目标范围：** Electron 桌面设置页；真实微信/飞书 owner 测试环境；脱敏存量 DB 副本；目标 OS 安装包。
  - **产物：** 外部验收记录（测试版本/账号环境、用例、结果、审批失效和 executor 未调用证据、迁移前后备份 hash、回滚结果）。
  - **完成判据：** 桌面自定义动作能控制真实调用；共享 IM 修改在两个 channel 正确生效；待审批/迟到批准按新策略收敛；已开始执行不被误称取消；存量 disabled 用户升级迁移与重启保持结果；正式包可启动并保存设置。
  - **验证方式：** 手工桌面与真实 IM scenario；目标平台 packaged app smoke test；存量数据库仅在隔离副本执行。
  - **环境 / 状态：** 外部 / 未开始；外部资源不到位时该任务保持未完成，不回写源码阶段为阻塞。

## 最终完成定义

- **源码阶段关闭：** Phase 0–5 关闭门槛完成；AC/INV 证据、相关测试、类型/i18n/build 与迁移回滚演练可复核。
- **产品启用/发布关闭：** T10 外部验收通过；未取得真实 IM、存量库或目标平台证据时，只能报告源码阶段完成，不能报告端到端发布验收完成。
- **提交纪律：** 每个独立阶段验收后单独提交；方案文档不记录任务状态，进度只更新本文；测试按仓库 AGENTS 规定的定向/阶段收尾策略执行。
