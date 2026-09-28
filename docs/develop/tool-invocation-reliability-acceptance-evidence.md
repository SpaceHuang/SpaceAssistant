# 工具调用可靠性改进（R1–R8）实施验收证据

- 实施分支：`feat/tool-invocation-reliability`（worktree `SpaceAssistant-tool-reliability`）
- 上游设计：`docs/develop/tool-invocation-reliability-improvement-technical-design.md`（v1.10）
- 状态：批 A（R1+R4）、批 B（R2+R3+R5）、批 C（R6+R7+R8）全部落地
- 日期：2026-09-28

## 1. 落地范围与关键文件

| 问题 | 批次 | 关键落地 | 测试 |
| --- | --- | --- | --- |
| R1 工作目录单源 | A | `src/shared/agent/workspace.ts`（快照/比较键/一致性断言）、`electron/workDirSnapshot.ts`（tracker：调用内冻结、调用间跟随，rebound 审计）、`AgentWorkspacePorts.snapshot()/refresh()`、assembler 装配、toolChatLoop 调用边界接线、`env.workspace` 删除全局 active 旁路、桌面链路注入 workDirManager | `workspace.test.ts`、`workDirSnapshot.test.ts`、`invocationAssembler.workspace.test.ts`、`env.test.ts` |
| R2 结构化诊断 | B | `src/shared/confirmation/diagnostics.ts`（DenyClass 三类 + 键参文案 + 建议动作）、`PolicyRule.denyClass` 全量标注（25 条，O4）、gate 汇总出口 `diagnostics`、审计 `denyClass`/`basis` 字段、i18n `toolReliability` 命名空间 | `diagnostics.test.ts`、`defaultRules.lint.test.ts`、`toolCallGate.test.ts`（诊断契约组） |
| R3 MCP 载荷 | B | `mcp-invocation` / `payload-incomplete` 信号、`mcpPayloadExtractor.ts`（截断+脱敏）、`approvalPayloadDecl.ts`（inputSchema.required 推导）、`confirm.payload-incomplete` 审计、CluePack 补 `argsDigest`/`targetUrl`/`targetPath` | `mcpPayloadExtractor.test.ts`、`approvalPayloadDecl.test.ts`、`toolCallGate.test.ts`（MCP 载荷组） |
| R4 结果信封 | A | `packages/agent-core/src/toolResultContract.ts`（五类失败码闭合枚举 + I0–I5 不变量 + 事实优先归一）、validator 切换（矛盾不再静默改判失败）、`SHELL_*`→新码映射（长期保留，O6）、`tool.result.contract-violation` 日志、`scripts/scan-tool-result-invariants.mjs` + `check:tool-result-invariants` 门禁 | `toolResultContract.test.ts`、`types.test.ts`、`scanToolResultInvariants.test.ts` |
| R5 解析失败降级 | B | `ShellSecurityVerdict` 新增 `unsupported`（+`unsupportedStructures`/`unsupportedReason`）、消费点显式排除（trust 两处 / canSkipShellConfirm）、gate 零特例下传 `shell-unsupported-structure` 信号、审批第三态 `undetermined`（Skill 合同 v2.2 / parseApprovalVerdict / agentChannel 三分支）、`agent-undetermined` cause + `agent_undetermined` notExecutedReason（N2 第六处）、回退白名单加格（O3b）、`automation-unsupported-deny` lane 限定 locked deny（O9 用户决策，排在 catch-all 之前）、`desktop-fail-open-to-user-plan.md` 权威文档同步（B15） | `toolReliabilityR5.test.ts`、`shellCommandTrust.test.ts`（T-R5-5）、`agentChannel.test.ts`、`fallbackToUser.test.ts`、Golden 基线重录（b36–b39 + t2-03） |
| R6 搜索范围透明 | C | `grepScope.ts`（`GREP_DEFAULT_IGNORES` 语义归一、`planGrepInvocation` 三形态规划、`formatGrepNoMatchOutput`、`grepSensitiveExcludes` 两引擎同源）、rg 接线（`--hidden` 按需 / 名单 glob 按解除 / 敏感 glob）、walk 对称（跳隐藏 + isSensitivePath，修掉「walk 能搜 .env」既有不一致）、`include_ignored` 参数与工具说明公开 | `grepScope.test.ts`、`grepScopeExecutor.test.ts`（T-R6-1/3/4/5/6） |
| R7 参数同源 | C | `normalizeGrepArgs` 单一入口（按生效值判定，等价默认值通过）、`validateGrepInput` 薄壳、执行器只读归一结果 | `grepNormalize.test.ts`、`grepInputContract.test.ts` |
| R8 目录错误分类 | C | `classifyDirectoryError` 五类（含 ABORTED）、list_directory 分支改造（ENOENT/EACCES/ENOTDIR/越界/超时各自成型 + suggestions）、`DIRECTORY_ACCESS_DENIED` / `DIRECTORY_READ_TIMEOUT` 新错误码 + i18n | `listDirectoryErrors.test.ts` |

## 2. 验收口径对照（需求 §5）

- **R1 四消费点一致**：`workspace.test.ts`（比较键）+ `invocationAssembler.workspace.test.ts`（装配快照 / refresh revision+1 / rebound 事件）。
- **R2 三类拒绝**：`denyClassMessageKey` 三键互不相同；`out-of-bounds` 文案参数强制含 `basisWorkDir`；`forbidden` 建议不含绕行。
- **R3 只读抓取**：`annotations-readonly` → `actionClass='read'` 不变；缺字段 → `payload-incomplete`（审计 reason 明示 construction，不出现「参数缺失」）。
- **R4 信封**：T-R4-1/2/3 覆盖 I1/I2/I3/I4/I5 与「矛盾改判」废除；扫描脚本退出码门禁就绪（当前 logs 目录无历史数据，矛盾数 0）。
- **R5 三态通过形态**：`unsupported` → desktop require-confirm（answerer=agent）→ 审批判危险 deny 不回退 / 判不了 `agent-undetermined` 回退人工（T-R5-6 端到端依赖 Electron 运行时，单测层以 fallbackToUser 四维判定 + agentChannel 三分支映射锚定）；automation → `automation-unsupported-deny` 拒绝且无 agent 侧 confirm.request（T-R5-2，O9 锚定）；危险命令仍 deny（T-R5-3）。
- **R6 三形态**：默认不搜并回报范围（no_match 必带 searchScope）；非隐藏/隐藏成员显式路径命中（自动 `--hidden`）；敏感文件默认与 `include_ignored` 均不搜、显式点名才搜且明示；两引擎同语义（walk 补对称）。
- **R7**：等价默认值不报错；冲突报 `param-conflict` 含建议写法；校验/执行同一实现。
- **R8**：不存在/指向文件/越界/超时四类 `errorClass` 与错误码互不相同，超时带 `retryable: true`。

## 3. 既有基线的口径迁移（有意变更，非回归）

1. **Shell Golden 基线重录**（b36-unclosed-quote / b37-trailing-pipe / b38-leading-and / b39-truncated-subst / t2-03-backtick-lead）：这五条「解析失败」样本的 verdict 按 R5 从 `deny` 迁移为 `unsupported`。Golden 的「verdict 弱化硬禁令」机制保持不变（防其他规则静默弱化），迁移通过重录基线完成并在此登记。**安全侧不变量**：这些样本 precheck 不再短路，但 `legacyAutoAllowEligible` 恒 false（analysisCompleteness=partial），desktop 落 require-confirm（永不自动放行），automation 由 locked deny 拒绝。
2. **`grepInputContract.test.ts`**：非 content 模式冲突文案从「仅适用于」迁移为 `param-conflict` 结构化形态（R7）。
3. **`toolCallGate.test.ts`** MCP 信号断言：`mcp-invocation` 与 `mcp-tool` 并存（R3 设计行为）。
4. **`fallbackToUser.test.ts`**：`FALLBACK_ELIGIBLE_CAUSES` 从两格扩为三格（R5）。

## 4. 门禁清单（CI 口径）

| 门禁 | 状态 |
| --- | --- |
| `npm run test:electron` | 434 文件 / 3607 passed / 0 failed（2026-09-28 评审修复后重跑，见 §4.2） |
| `npm run test:renderer` | 294 文件 / 1937 passed / 0 failed（同上） |
| `npm run check:tool-result-invariants` | 矛盾数 0（exit 0） |
| `npm run i18n:check` | 通过（zh-CN / en-US 对齐） |
| `npm run typecheck:renderer` / `typecheck:shared` | 通过 |
| 护栏断言（`electron/toolReliabilityGuards.test.ts` 10 条） | 通过：active 旁路 / refresh 优先 / 失败态单一推导 / 归一单一出口 / 新失败码 / unsupported 信任排除 / O9 规则序 / 回退白名单 / grep 单一出口 / 目录四分类 |

## 4.1 评审修复批次（2026-09-28，13 项 P1 全量处置）

对照 `docs/review/2026-09-28-tool-invocation-reliability-code-review.md` 的修复记录：

| # | 修复 | 落点 |
| --- | --- | --- |
| A1 | Skill 版本断言 2.1.0→2.2.0 + 三态合同断言 | `securityApprovalSkill.test.ts` |
| B1 | `shell-unsupported-structure` 阻断持久记忆资格（memoryEligibility 排除清单 + gate 端到端「缓存 allow 不命中」断言，persistable=true 形态） | `memoryEligibility.ts`、`toolReliabilityR5.test.ts` |
| B2 | 段数超限保留 precheck 结构化短路（extractor 不再被 >50 段命令炸穿整轮循环）；structure 类 unsupported 语义不变 | `shellToolLoopHelpers.ts` |
| B3 | 审批收束指令改三态 + JSDoc 同步 + 「提示词与 Skill 三态合同一致性」护栏 | `approvalAgent.ts`、`approvalAgent.test.ts` |
| C1 | Windows 盘符根（E:\）归一保留尾分隔符（resolve 前拦截，沙箱基座不漂移到进程 cwd） | `src/shared/agent/workspace.ts` |
| C2 | basis-mismatch 护栏：fail-loud 判据改 `app.isPackaged`（NODE_ENV 打包态恒真）+ legacy 侧 realpath 归一后再比 key（junction/subst/8.3 不误报）+ junction 行为测试 | `toolChatLoop.ts`、`workDirSnapshot.junction.test.ts` |
| D1 | rg 排除 glob 改 `--iglob` 大小写无关消费（Secrets/.ENV 变体不绕过；与 isSensitivePath 小写化口径同源） | `grepScope.ts`、`builtinExecutors.ts` |
| D2 | 显式点名判定改「任一路径段命中」（嵌套成员 sub/node_modules/pkg 解除；嵌套隐藏段 → --hidden） | `grepScope.ts` |
| E1 | MCP 入参摘要递归脱敏（headers.Authorization / auth.token / apiKeys[] 等任意深度） | `mcpPayloadExtractor.ts` |
| E2 | `renderCluePack` 渲染 `argsDigest`（不可信围栏内）——R3 审批可见入参对裁决模型可达（依赖 E1 先落地） | `approvalAgent.ts`、`agentChannel.test.ts` |
| F1 | readdir 阶段五类分类闭合（stat 后目录消失的竞态不再 throw 逃逸） | `builtinExecutors.ts` |
| F2 | entries 循环阶段 abort/超时统一结构化 `READ_TIMEOUT`（消除 throwIfAborted 逃逸与中文句子 error 两种旧形态） | `builtinExecutors.ts` |
| F3 | contract-violation 告警收窄到 I0–I4（I5 未知码不落日志）+ SCRIPT_*/LARK_* 业务码纳入闭合集合 | `toolChatLoop.ts`、`errorCodes.ts` |

护栏测试扩至 16 条（新增 C2 判据 / B1 记忆阻断 / B3 三态表述 / F3 收窄与闭合 / D1D2 / E1E2）。

## 4.2 门禁真实运行记录（2026-09-28，评审修复后）

- `npm run test:electron`：**434 文件 / 3607 passed / 5 skipped / 0 failed**（exit 0，458s）
- `npm run test:renderer`：**294 文件 / 1937 passed / 0 failed**（exit 0）
- `npm run check:tool-result-invariants`：`files=0 violations=0`，退出码 0
- `npm run i18n:check`：passed（zh-CN / en-US 对齐，1623 处既有硬编码为存量基线）
- `npm run typecheck:renderer` / `typecheck:shared`：通过
- `npx tsc -p tsconfig.electron.json --noEmit`：通过

## 5. 遗留与后续

- T-R5-6 的端到端（真实 Electron 会话内「判不了 → 弹卡 → 人工确认」）与「补信息重试即通过」的会话级证据需真机验证一次（本分支无法在单测环境内发起真实 LLM 会话）；机制层（fallback 判定、cause 映射、i18n 键）已由单测锚定。
- `check:tool-result-invariants` 当前扫描 `logs/` 为空（开发态尚无历史事件流）；打包态 `{workDir}/.agent/logs/**` 由脚本参数支持，接入 CI 时按环境传参。
- P-1（敏感路径跨工具一致）、P-2（automation 下 extraction-failed）按设计文档 §9.1 保持独立待立项，未在本分支改动。
