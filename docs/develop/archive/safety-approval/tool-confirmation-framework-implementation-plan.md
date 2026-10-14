# 工具确认机制框架重构 技术方案（v8）

> **⚠️ 已归档（2026-09-05）**：本方案规划的内容已通过 `codex/tool-confirmation-framework` 分支实现，并于 `703b47f` 合并回 `main`。落地代码位于 `electron/confirmation/`、`src/shared/policy/`、`src/shared/confirmation/` 以及设置页「工具与安全」；`toolChatLoop.ts` 已由 2236 行瘦身至 1785 行。本文档仅作历史留存，**不再作为待实施计划**，请勿据其再排期实施。

> 依据：`docs/requirement/tool-confirmation-top-level-design-v2.md`（下称"顶层设计"，含 §3.8 安全审计日志）
> 评审：v1（4 阻断项）、v2（1 阻断 + 5 非阻断）、v3 补遗（1 阻断）、v4（1 阻断 + 4 非阻断）、v5（4 阻断 + 4 非阻断）、v6（2 阻断 + 2 非阻断）、v7（1 阻断 + 2 非阻断）、v8（1 阻断 + 3 非阻断），均已修订，修订记录见文末 §12。
> 状态：v8，修订后可进入 P0
> 前置依赖：**本方案基于 `docs/plan/remove-artifact-management-plan.md`（移除产物管理机制）落地之后的代码**。两计划的执行顺序与版本口径见 §1.3。
> 范围：只做**确认机制框架重构**（顶层设计 P0–P4 的框架部分，含 §3.8 安全审计日志）。**不做**沙箱与提权（§3.7）、不做 automation 链路（P5）、不做远程指令执行模块。涉及沙箱的类型字段只落 reserved 定义，不产生任何行为。

## 1. 目标与边界

### 1.1 本次迭代要交付什么

一句话：把"某个工具这次调用要不要问用户"这个判断，从 `toolChatLoop.ts` 里约 500 行内联代码和三套各自为政的确认管理器中抽出来，变成**一处提取事实、一处查规则判定、各链路只负责把问题送达用户**的结构，并且每一次判定与回答都有据可查。

具体交付五件事：

1. **事实提取层**：把现在散在 `analyzeScriptContent`、`precheckRunShellTool`、`browserActionNeedsConfirmation`、`larkCliWriteNeedsConfirm` 里的内容分析，统一成一组"只产出事实、不做判定"的提取器。
2. **策略层**：一个纯函数判定器，输入事实 + 链路上下文 + 配置 + 缓存只读视图，输出"放行 / 问用户 / 拒绝"。规则全部数据化，主循环不再承载任何具体规则。
3. **确认通道合并**：桌面卡片、微信、飞书三路确认合并为两个通道实现（桌面通道 + IM 通道），消灭 `feishuConfirmManager` / `weChatConfirmManager` 的同构重复。
4. **决策缓存统一**：shell 信任命令、浏览器域名信任（持久 + 会话级）、MCP 会话信任等"下次别问了"收敛为一张 `decision_cache` 表 + 一个确认记忆管理界面。**远程写授权 grant 不在其列**（带额度记账与租约语义，属带状态控制流，按读写拆分处理，见 §5.3）。
5. **安全审计日志**（顶层设计 §3.8）：独立的 `SecurityAudit-{YYYYMMDD}.log`（JSON Lines），判定、确认交互、缓存读写、配置变更四类事件全覆盖——确认框架是安全模块，审计日志是它的证据链本体，不是附属物。

### 1.2 明确不做

- 沙箱、提权、沙箱外执行（顶层设计 §3.7）：独立规划，本期只落 reserved 类型字段。
- automation 链路（定时任务）接入：本期只保证架构上预留 lane 值和套餐模型，不实现。
- 远程指令执行模块：不在范围内。
- UI 层非工具类确认（删除会话弹窗等）：不动。
- P0–P2 不引入任何用户可见行为变化；P3（缓存迁移）、P4（设置中心）才有用户可见变化。

### 1.3 与「移除产物管理」计划的执行顺序（硬约束）

仓库内另有一份已过评审、处于待实施状态的 `docs/plan/remove-artifact-management-plan.md`（移除产物管理机制），与本方案在 schema 版本号、`toolChatLoop.ts` / `builtinToolDefinitions.ts` 同批重写、行为基线三个点上存在硬冲突。定稿如下：

- **执行顺序：产物移除先行，本方案随后。** 依据：产物移除计划的保留清单明言"保留写入审批"，即本方案范围；反向执行则两计划的 v3 迁移互斥（谁先合入，谁的 `if (version === 2)` 迁移在后合入方身上静默跳过）。
- **schema 版本口径**：产物移除将 `DB_SCHEMA_VERSION` 升为 3（`if (version === 2)` 执行 DROP TABLE）；本方案在其之上 **3 → 4**（`if (version === 3)` 建 `decision_cache` / `policy_rules`），若届时实际版本再变，按实际版本顺延并在实施前核对。
- **基线口径**：§2 的行号与散布点清单以**产物移除后的代码**为准，P0 启动前重新核对一遍；`toolChatLoop.ts` 中 artifact 写入决策流（`resolveArtifactToolWriteWithDecision` + `onDecisionRequired` + `artifact:decision-request` 桌面事件 + `sendRemoteArtifactDecisionPrompt` IM 提示）已随产物移除删除，**不在本方案迁移范围**，特此备案。

## 2. 现状盘点（代码事实）

以下为摸底核实后的关键事实（已经评审逐项实地复核通过），是后续方案的对照基线。**行号基线为产物移除前的现状，用于说明散布点位置；产物移除落地后需按其代码重新核对（见 §1.3）**：

- `toolChatLoop.ts`（2236 行）内确认决策散布在至少 8 个位置：
  - `:917` 远程出站阻断 `evaluateRemoteToolBlock`（`:2181`）
  - `:958` 出站写预算门控 `evaluateOutboundWriteBudgetGate`（`:2099`）
  - `:1022` shell 预检 `precheckRunShellTool`（实现于 `electron/shell/shellToolLoopHelpers.ts`）
  - `:1156` 写文件 auto 审批 `evaluateWriteFileAutoApproval`（`electron/tools/writeFileAutoApproval.ts`），**代码明确 `!remoteContext`，仅桌面链路生效**
  - `:1280` 确认基线 `toolNeedsUserConfirmation`（`:2126`）
  - `:1291-1439` MCP 会话信任、远程写授权 grant、脚本分析、浏览器远程跳过的逐工具覆写
  - `:1441-1540` / `:1541-1662` 远程 / 桌面确认双分叉
- **browser act 高危的现状态度是"问"不是"拒"**：`toolChatLoop.ts:1367` 特判——browser act 且 `dangerAssessment?.dangerous` 时保留确认（"High-impact / uncertain act must still confirm"），`:1548` 桌面确认卡片携带该评估展示。这是现状有意的保守设计，迁移时不得静默升级为拒绝（§5.1 信号档位映射表裁决）。
- 两套并行的待确认注册表：桌面 `toolConfirmRegistry.ts`（5 分钟）、IM `PendingRequestRegistry`（微信 5 分钟 / 飞书 10 分钟）。
- `feishuConfirmManager.ts`（306 行）与 `weChatConfirmManager.ts`（281 行）结构几乎一致，经 `remoteConfirmBridge.ts` 两个对称工厂接入。
- 确认名单与风险等级硬编码在 `src/shared/domainTypes.ts:516`（`builtinToolNeedsConfirmation`）和 `:492`（`builtinToolRiskLevel`），工具定义（`builtinToolDefinitions.ts`）本身不带任何确认/风险元数据。
- 工具暴露过滤是两条 if 链：主进程 `electron/toolsConfigRuntime.ts:23`、渲染镜像 `src/shared/toolsConfigFilter.ts:5`。
- 设置入口分散在 4 个 Tab（Tools / Browser / Shell / RemoteImCommon）。
- 数据库迁移模式现成：`electron/database/migrations.ts` 逐级 if 链 + `DB_SCHEMA_VERSION` bump；configs 走 `configs` 表 key-value；远程安全配置已有版本门控先例（`remoteSecurityConfigVersion`）。
- **远程写授权 grant 的非布尔语义**：`remoteWriteGrantRegistry.ts` 的 grant 携带 `remainingOps` / `remainingBytes` 额度，`reserve({ byteCount })` 会扣减额度、额度不足拒绝（`:144-148`）；`toolChatLoop.ts:1332` 侧另有 `isRequestLeaseOwner` 租约归属校验与 `authorizationGeneration` 代际校验。**它不是"记住用户回答"，是带记账的有状态授权**——这决定了它不能进 `decision_cache`（§5.3）。
- JSON Lines 文件日志有现成模式可循：飞书 `FeishuCli-{YYYYMMDD}.log`、微信 `WeChatCli-{YYYYMMDD}.log`（开发模式 `{项目根}/logs/`、打包 `{workDir}/.agent/logs/`，写入前经 `sanitizeForLog` 脱敏）——安全审计日志照此模式实现，但文件独立、保留策略独立。

## 3. 总体结构（落地到本仓库）

```
IM 消息入口 handler（仅 IM 链路）
   └─ 0. decideIngress(ingressFacts, rules)   ← 消息准入："这条消息该不该被响应"（§5.2a）

toolChatLoop 主循环（瘦身后）
   │
   ├─ 1. 组装 ExecutionContext（lane / origin / 会话状态 / 额度余量 / grant 余量）
   │
   ├─ 2. FactExtractor.extract(toolInput) ──→ ContentFacts（事实 + 展示摘要）
   │        electron/confirmation/extractors/  ← 现有分析代码迁移而来
   │
   ├─ 3. PolicyEngine.decide(facts, context, rules, cacheView) ──→ Decision
   │        src/shared/policy/（纯函数，可单测）   规则 = 数据（内置默认 + 配置覆盖）
   │        cacheView：P1 为存量豁免适配器，P3 换 decision_cache 存储，接口不变（§5.3）
   │
   ├─ 4a. auto-allow → 直接执行（执行链路侧记账：出站预算、grant reserve、缓存命中计数）
   ├─ 4b. deny → 返回工具错误结果
   └─ 4c. require-confirm → ConfirmationChannel.request(req)
              ├─ DesktopChannel（包装现 toolConfirmRegistry + 确认卡片）
              └─ ImChannel（合并飞书/微信，包装现 PendingRequestRegistry）
                     │
                     └─ 用户回答 → 执行链路侧的缓存管理器写缓存

贯穿全程（执行链路侧）：SecurityAuditLog
   主循环 / 通道 / 缓存管理器 / 设置处理器在拿到结果后异步落审计事件（§5.6）
   ——策略层保持纯函数，不发事件；写日志与写缓存同侧。
```

新增/改动目录一览：

| 位置 | 内容 | 新建/改动 |
|---|---|---|
| `src/shared/confirmation/types.ts` | ExecutionLane、ExecutionContext、ToolActionDescriptor、ContentFacts、Decision、CacheKey、SecurityAuditEvent 等全部框架类型 | 新建 |
| `src/shared/policy/policyEngine.ts` | 纯函数判定器 + 规则评估循环 + `decideIngress` 入口 | 新建 |
| `src/shared/policy/defaultRules.ts` | 内置预置规则条目（数据，含 locked 条目） | 新建 |
| `src/shared/builtinToolDefinitions.ts` | 每个工具补 `actionClass / riskLevel / extractors` 元数据 | 改动 |
| `electron/confirmation/extractors/` | 命令分解、路径分类、网络出口、脚本分析等提取器 | 新建（代码从现位置迁入） |
| `electron/confirmation/channels/desktopChannel.ts` | 桌面确认通道 | 新建（包装 toolConfirmRegistry） |
| `electron/confirmation/channels/imChannel.ts` | IM 确认通道（飞书/微信合一） | 新建（吸收两个 ConfirmManager） |
| `electron/confirmation/decisionCache.ts` | 缓存只读视图 + 写入 + TTL/休眠/会话清理；P1 内含存量豁免适配器 | 新建 |
| `electron/confirmation/securityAuditLog.ts` | 审计事件构造、脱敏、异步缓冲批量落盘、按日切分、保留天数清理 | 新建（模式对照飞书/微信 CLI 日志） |
| `electron/database/schema.ts` / `migrations.ts` | 新增 `decision_cache`、`policy_rules` 表 | 改动 |
| `electron/toolChatLoop.ts` | 主循环瘦身为"组装上下文 → 提取 → 判定 → 通道/执行" | 改动（删除约 400 行内联判断） |
| `electron/toolsConfigRuntime.ts` | 工具过滤 if 链改为 exposure 规则评估；渲染进程改为消费主进程评估结果 | 改动 |
| 渲染进程 `Config/` | 新"工具与安全"设置页（五区）+ 确认记忆管理 + 审计记录查看 | 新建/改动 |

## 4. 类型设计（`src/shared/confirmation/types.ts`）

按顶层设计 §3 落地，只保留本期需要的字段；沙箱相关字段以 reserved 注释落定义。对顶层设计 §3.5 的 Decision 定义有两处实现层补全（均需同步回顶层设计）：

- `require-confirm` 必须携带 `memoryTiers`（v2 已补）——否则 `buildConfirmRequest(decision)` 无从取值；
- **三个分支都必须携带 `ruleId`**（deny / auto-allow / require-confirm 均带命中规则 id）——否则 `policy.decision` 审计事件落不出"命中规则与原因"，"为什么没问我/为什么拒绝"也无从解释。

```ts
// 执行链路
type ExecutionLane = 'desktop' | 'wechat' | 'feishu' | 'automation'; // automation 本期仅定义

// 指令来源（只有 IM 链路能区分，desktop 恒 direct-owner）
interface OriginInfo {
  kind: 'direct-owner' | 'direct-other' | 'group';
  senderId?: string;
}

// 每次工具调用的完整上下文
interface ExecutionContext {
  lane: ExecutionLane;
  origin: OriginInfo;
  sessionId: string;
  outboundWriteBudgetRemaining?: number;   // 出站写额度余量（读，由执行链路注入）
  remoteWriteGrant?: { remainingOps: number; remainingBytes: number } | null;
                                           // 远程写授权余量（读）；reserve 扣减仍在执行链路
  declaredCapabilities?: DeclaredCapability[]; // 套餐 B 预留，本期无人写入
}

// 消息入口准入的事实（ingress 时机专用，不经 ContentFacts——此时还没有工具调用）
interface IngressFacts {
  lane: ExecutionLane;
  origin: OriginInfo;      // 由 IM 链路适配器产出；发送者白名单校验在分类器内完成（§5.2a）
}

// 工具静态元数据（收敛 builtinToolNeedsConfirmation / builtinToolRiskLevel）
interface ToolActionDescriptor {
  toolName: string;
  actionClass: 'read' | 'write' | 'execute' | 'outbound';
  riskLevel: 'low' | 'medium' | 'high';
  extractors: string[]; // 启用哪些提取器
}

// 事实：策略层唯一的决策依据，也是确认界面的展示内容
interface ContentFacts {
  toolName: string;
  actionClass: ActionClass;
  baseRiskLevel: RiskLevel;
  signals: FactSignal[];
  summary: ConfirmSummary;      // 给用户看的内容摘要（桌面卡片与 IM 文本共用同一份）
}

// Decision：三分支均带 ruleId；require-confirm 必须带 facts 与 memoryTiers（禁止盲确认）
type Decision =
  | { type: 'auto-allow'; ruleId: string; cacheKey?: CacheKey; reason: string }
  | { type: 'require-confirm'; ruleId: string; riskLevel: RiskLevel; facts: ContentFacts;
      memoryTiers: MemoryTier[]; timeoutMs: number | null }
  | { type: 'deny'; ruleId: string; reason: string };

// ConfirmOutcome：在 approved/rejected/timeout 之外补"带动作批准"，
// 承接预算耗尽的三选交互（继续=提额续跑 / 回桌面 / 停止=撤销任务）。
// 注意：approved-with-action 与 timeout 是额度/流程决策，不是"这次调用该不该允许"的回答，
// 不产生缓存写入（§5.5）。
type ConfirmOutcome =
  | { kind: 'approved'; memory?: CacheKey }        // 含用户选中的记住档次（或无）
  | { kind: 'rejected'; memory?: CacheKey }        // 拒绝方向同样可记
  | { kind: 'timeout' }
  | { kind: 'approved-with-action'; action: 'continue' | 'back-to-desktop' | 'stop' };
```

安全审计事件（顶层设计 §3.8 原样落地）：

```ts
interface SecurityAuditEvent {
  ts: number;
  event: SecurityAuditEventKind;
  lane: ExecutionLane; origin?: OriginInfo;
  sessionId: string; requestId?: string;   // requestId = 确认请求短号（复用 allocateConfirmId）
  toolName?: string; actionClass?: ActionClass; riskLevel?: RiskLevel;
  factsSummary?: string;                   // ConfirmSummary 纯文本摘要（事实，非原始输入全文）
  signals?: string[];                      // 命中的信号 kind 列表
  decision?: 'auto-allow' | 'require-confirm' | 'deny';
  ruleId?: string; reason?: string;
  outcome?: 'approved' | 'rejected' | 'timeout' | 'cancelled';
  memoryTier?: string;                     // 用户所选档位的规范化签名文本
  cacheKey?: string;                       // 规范化签名文本（与缓存键同源，可对账），不落原始输入
  actor: 'user' | 'system' | 'migration';
}

type SecurityAuditEventKind =
  | 'policy.decision' | 'policy.deny-ingress' | 'policy.deny-exposure'
  | 'confirm.request' | 'confirm.outcome'
  | 'cache.hit' | 'cache.write' | 'cache.clear' | 'cache.expire-dormant'
  | 'cache.generation-reset'
  | 'settings.policy-change' | 'settings.tool-toggle'
  | 'budget.exhausted'
  | `migration.${string}`;
```

其余 `FactSignal`、`CacheKey`、`DecisionCacheEntry`、`MemoryTier`、`ConfirmRequest`、`ConfirmationChannel` 均按顶层设计 §3.3–§3.6 的定义原样落地。其中 `allowElevation`、`sandbox-escape` 信号标注 `// reserved: 沙箱迭代启用`。

**工具元数据初值表**（迁移时逐工具核对，与顶层设计 §3.2.1 基线表一致）：

| 工具 | actionClass | riskLevel | extractors |
|---|---|---|---|
| read_file / grep / list_directory / browser_detect / read_feishu_attachment | read | low | [] |
| list_work_dirs / switch_work_dir / switch_session | read | low | [] |
| edit_file / write_file | write | medium | ['path-classifier'] |
| run_shell | execute | high | ['command-sequence', 'path-classifier', 'network-egress'] |
| run_script | execute | high | ['script-analysis', 'path-classifier'] |
| run_lark_cli | execute | high | ['lark-subcommand'] |
| browser | outbound | medium | ['browser-domain'] |
| wechat_reply / wechat_send | outbound | low | ['outbound-target'] |

MCP 工具在注册时按 server 声明的只读/写能力归类；缺元数据的工具默认 `require-confirm`（信息不足宁可多问）。

## 5. 模块设计

### 5.1 事实提取层（`electron/confirmation/extractors/`）

原则：**只产出事实，不做放行/拒绝判定**。现有分析代码全部改为"输出信号"而不是"输出 verdict"：

| 提取器 | 来源 | 迁移方式 |
|---|---|---|
| `commandSequenceExtractor` | `shellCommandParser.ts` + `shellSecurity.ts` | 把 `analyzeShellCommand` 的判定部分剥离，只留子命令分解与签名产出；deny 判定改由策略层查规则得出 |
| `pathClassifier` | `shellPathAnalysis.ts` / `shellSensitivePaths.ts` + `writeFileAutoApproval.ts` 的敏感路径判断 | 路径 → `system-dir / outside-workdir / sensitive-file / workdir-normal` |
| `scriptAnalysisExtractor` | `scriptContentSecurity.ts` | `analyzeScriptContent` 返回值从 `verdict: allow/ask/deny` 改为"**模式级事实**"：`signal: clean/suspicious/dangerous + patterns`；**网络类命中单独产 `script-network` 信号**（独立于通用 `network-egress`，避免与 browser / run_shell 的网络出口事实混用，见 §5.2 规则条目）；**远程认证态产独立信号 `script-uncertified`**（未通过 `isScriptCertifiedRemoteSafe` 认证时产出，通过认证则不产该信号——信号以"出现/不出现"表达布尔事实，与 `PolicyRule.match` 的类型定义对齐）。提取器本身不感知 lane——现状的两处链路依赖（`networkVerdict = ctx?.remote ? 'deny' : 'ask'`、`remote && allow && !certified → ask`）分解为事实 + 规则表按 lane 消费（见映射表与 §5.2 规则条目） |
| `browserDomainExtractor` | `browserActionPolicy.ts` | 动作 + 目标域名 → `network-egress` / `domain` 信号；域名信任命中判断移出，改由缓存查询承担 |
| `larkSubcommandExtractor` | `larkCliWriteNeedsConfirm` 内联逻辑 | 子命令 → 读/写分类 + 出站目标信号 |
| `outboundTargetExtractor` | 新建 | wechat_send/reply 的接收者 |

**现状判定 → 信号档位映射表**（P1 行为等价的裁决基准，实现时不许临场自由发挥）。脚本分析现状是**链路感知**的，映射表对脚本分析按链路分叉列逐格定死：

| 现状判定来源 | 现状结论 | 迁移后事实/信号 | 桌面链路规则 | 远程链路规则 | 等价性说明 |
|---|---|---|---|---|---|
| `analyzeScriptContent` | `verdict: 'allow'` | `clean` | **auto-allow**（跳过确认） | **clean + 已认证 → 消费 `remoteScriptRequiresConfirm`**（配置为 false 且安全迁移完成 → auto-allow，否则 ask；迁移门控语义保留为规则参数）；**clean + 未认证（`script-uncertified`）→ ask** | 等价。桌面现状 verdict allow 即 `needsConfirm = false` 直接执行（`toolChatLoop.ts:1407-1417`）；远程现状由 `shouldSkipRemoteScriptConfirmOnAllow` 门控（`remoteToolPolicy.ts:81-84`：安全迁移完成且 `remoteScriptRequiresConfirm === false` 才 skip，默认确认）。§5.2 落对应默认规则条目承载 |
| `analyzeScriptContent` | `verdict: 'ask'` | `suspicious` | 确认 | 确认 | 等价（预置套餐下 suspicious → 确认） |
| `analyzeScriptContent` | `verdict: 'deny'` | `dangerous` | 硬拒绝 | 硬拒绝 | 等价（预置套餐下 dangerous → 硬拒绝） |
| `analyzeScriptContent` **网络模式命中**（现 `networkVerdict`） | **桌面 ask / 远程 deny**（`ctx?.remote ? 'deny' : 'ask'`） | **`script-network` 信号**（脚本专属，随 script 信号携带 patterns；与通用 `network-egress` 区分） | **ask** | **deny** | **裁决：按 lane 分叉两条规则定死，且 match 均限定 `toolName: 'run_script'` + `signals: ['script-network']`**——`{ lane: ['desktop'], … } → ask`、`{ lane: ['wechat','feishu'], … } → deny`。禁止把网络命中笼统映射 dangerous（会把桌面从"问"静默升级为"拒"）或 suspicious（会把远程从"拒"松动为"问"）；**双重限定（独立信号 + toolName）确保 browser / run_shell 的通用 `network-egress` 不受波及**（远程 browser navigate 默认免确认、browser act 走确认、shell 网络命令按模式判定等现状行为逐项不变，回归用例见 §9） |
| `analyzeScriptContent` **远程认证降级**（`remote && allow && !isScriptCertifiedRemoteSafe → ask`，`reason: 'remote_not_certified'`） | 远程 clean 但未认证 → ask | **`script-uncertified` 信号**（未认证时产出） | —（桌面不消费） | `{ lane: 远程, run_script, script-uncertified } → ask`；已认证 → 消费 `remoteScriptRequiresConfirm`（见 allow 行） | 等价。认证态以信号"出现/不出现"表达，与 `PolicyRule.match` 类型对齐（不引入未定义的 `facts` 匹配维度）；禁止"clean 即免认证放行"或"clean 一律问" |
| shell 预检 `analyzeShellCommand` | verdict deny 各原因 | `dangerous` | 硬拒绝 | 硬拒绝 | 等价（现状直接拒绝） |
| **browser act `dangerAssessment.dangerous`** | **保留确认（ask）** | **`suspicious`** | 确认 | 确认（现有远程确认策略） | **裁决：映射 `suspicious`，不映射 `dangerous`。** 现状是有意的保守设计（用户确认后可执行），升级 deny 会砍掉合法路径、违反 P1"无用户可见变化"。顶层设计需同步补注：browser 高危关键词属 ask 档，不属 dangerous 硬拒档 |
| `larkCliWriteNeedsConfirm` 写类子命令 | 确认 | `outbound-target`（写类标记） | 确认 | 确认 | 等价（确认与否由规则表按链路决定） |

三个硬性规矩（对应顶层设计三原则）：

1. 提取器接口不允许返回判定结论，类型上就没有这个字段。
2. 提取失败必须产出 `extraction-failed` 信号，策略层遇到它一律"问用户"，不允许放行。
3. 每个提取器同时产出 `summary` 片段——确认卡片和 IM 消息展示的是同一份摘要，不允许通道自己再拼一份。

环境事实（操作系统、workDir 根、敏感目录清单）由平台层注入 `EnvFacts`（纯值对象），提取器不各自硬编码路径。**约定：策略层与默认规则的单元测试不得 mock Electron 或 Node 环境对象，`EnvFacts` 一律以字面量传入**——纯函数层不许悄悄长出环境依赖。

### 5.2 策略层（`src/shared/policy/`）

两个纯函数入口，共用同一个规则匹配器：

```ts
// 工具调用时机（invocation）与工具暴露时机（exposure）
function decide(
  facts: ContentFacts,
  context: ExecutionContext,
  rules: PolicyRule[],       // 内置默认 + 用户配置覆盖，按 when 过滤后按固定优先级评估
  cache: DecisionCacheView,  // 只读视图；写缓存是执行链路的事
): Decision

// 消息入口时机（ingress）：没有工具调用，输入是链路 + 指令来源
function decideIngress(
  facts: IngressFacts,
  rules: PolicyRule[],       // 只消费 when:'ingress' 的条目
): { action: 'allow' | 'deny'; ruleId: string; reason: string }
```

**规则匹配与裁决机制（定死，四条一句话约定）**：

1. **`signals` 匹配语义为"包含"**：`match.signals` 所列信号全部出现在事实的信号集中即命中，不要求信号集全等（同一事实携带多个信号是常态，如网络-only 脚本同时含 `clean` + `script-network`）。
2. **规则优先级 = 规则数组顺序、首条命中即返回**：`decide` 按 when 过滤后，按数组顺序逐条评估，第一条命中的规则产生 Decision，后续规则不再评估；不存在"更具体优先"或"按 action 宽严排序"等其他机制。**唯一例外：`action: 'auto-evaluator'` 的命中不产生 Decision**——评估器裁决通过（allow）才返回 Decision，不裁决（评估不通过或信息不足）则**交还规则链，继续评估后续条目**（最终通常落到第 6 步默认表的 ask）；评估器未完成评估绝不放行，也绝不把"不裁决"直接变成 ask 截断规则链。
3. **规则排序规范：同一匹配域内，安全规则（deny / 强制 ask）必须先于放行规则（allow / 条件放行）排列**——`defaultRules.ts` 的条目顺序是行为基线，新增规则插入时必须遵守此序。**例外：带 `requiresContext` / `configRequires` 门控的条件放行条目，门控不满足即不命中（对不满足条件的调用不可见），可先于同域 ask 条目排列**——`remote-write-grant-allow` 先于 `im-write-ask` 即此例，是行为等价的刻意定序。
4. **数组顺序与 1→6 步骤链的归并口径**：规则数组按步骤分段排序——`locked && action === 'deny'` 条目属**第 1 步段**（含 `dangerous` 信号硬拒、出站硬禁、链路硬约束），`auto-evaluator` 条目属**第 4 步段**，其余 ask/allow 条目属**第 6 步段默认表**；**缓存检查（第 2 步）与能力声明放行（第 3 步）是引擎内嵌在两段之间的固定步骤，不是规则条目**。由此"缓存查询永远排在硬拒绝之后"与"首条命中即返回"两个口径合一，实现者无需自行判断条目与步骤的归属。

`decide` 的评估顺序固定为顶层设计的 1→6（代码里就是一个数组 + 一个循环，不存在第二个入口）：

1. 硬拒绝：`deniedTools`、locked 条目、出站硬禁、链路硬约束、`dangerous` 信号（预置套餐下）。
2. 缓存命中：用事实的规范化签名做键；命中即按缓存的 allow/deny 返回。**缓存查询永远排在第 1 步之后，这是安全不变量，写成单元测试固定下来**（含变体绕过测试集：环境变量前缀、`cd x && cmd`、引号/空白变体不得命中 exact 档缓存）。
3. 能力声明放行：本期只实现规则骨架（`declaredCapabilities` 无人写入时该规则不命中），为套餐 B 预留。
4. 自动审批器：现 `evaluateWriteFileAutoApproval` 泛化。**与现状严格等价的前提：该规则的 match 固定含 `lane: ['desktop']` + 工具域限定 `write_file`/`edit_file` + `confirmMode === 'auto'` 配置前置**——现状代码明确 `!remoteContext && (write_file || edit_file) && confirmMode === 'auto'`（`toolChatLoop.ts:1032-1036`），三者缺一即破坏等价：不带 lane 约束会把桌面 auto 判定渗到远程链路；不带工具域与配置前置会让 lane-only 匹配截胡桌面全部调用（read 类工具与 clean 脚本被误送评估器）。向其他工具/链路泛化属可见变化，不在本期。评估器绝不自行放行，不裁决时交还规则链后续条目（含第 6 步默认表）裁决（见约定 2 的唯一例外条款）。
5. 链路软约束：只影响体验（如 IM 确认超时长短），无安全含义。
6. 默认：按 `actionClass + riskLevel + signals` 查策略表；含 `extraction-failed` 一律问用户。

规则数据化：`defaultRules.ts` 把现在写死的判断逐条落成数据条目，每条带 `reason`。其中**六条脚本规则连同其顺序是规范条目（P1 等价验收的裁决依据，不得自由调整）**，其余条目为示例（语义等价于现状，只是从代码变成数据）。**下方清单按可读性分组呈现；`defaultRules.ts` 的实际数组顺序一律按约定 4 分段组装**（第 1 步段 locked deny 条目在前，第 4 步段 `auto-evaluator` 条目居中——`desktop-auto-approve` 位于六条脚本规则之后的口径即以分段序为准，第 6 步段条目殿后，段内再按约定 3 排序）：

```ts
{ id: 'im-no-wechat-send', when: 'exposure',
  match: { lane: ['wechat', 'feishu'], toolName: 'wechat_send' },
  action: 'deny', locked: true, reason: '远程会话不允许主动发微信' }

// grant 消费规则（示例）：远程写授权有效且余量充足 → 免确认直接执行
// （等价于现状 grant 额度内直接 reserve 执行；定序先于 im-write-ask，
//  否则授权签发后的续写会退化为每次确认，破坏 P1 等价）
{ id: 'remote-write-grant-allow', when: 'invocation',
  match: { lane: ['wechat', 'feishu'], actionClass: 'write' },
  action: 'allow', requiresContext: { remoteWriteGrantValid: true },
  reason: '远程写授权 grant 有效且余量充足时免确认' }

{ id: 'im-write-ask', when: 'invocation',
  match: { lane: ['wechat', 'feishu'], actionClass: 'write' },
  action: 'ask', reason: '远程链路写本地文件默认需要确认' }

// ===== 以下六条脚本规则为规范条目（顺序即优先级，安全规则先于放行规则），是 P1 等价验收的裁决依据 =====

// 脚本网络命中的 lane 分叉（等价于现 networkVerdict = ctx?.remote ? 'deny' : 'ask'）。
// 双重限定：独立信号 script-network（脚本专属，区别于通用 network-egress）+ toolName，
// 确保 browser / run_shell 携带的 network-egress 不命中这两条规则。
{ id: 'script-network-deny-remote', when: 'invocation',
  match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-network'] },
  action: 'deny', locked: true, reason: '远程链路禁止执行含网络访问的脚本' }

{ id: 'script-network-ask-desktop', when: 'invocation',
  match: { lane: ['desktop'], toolName: 'run_script', signals: ['script-network'] },
  action: 'ask', reason: '桌面执行含网络访问的脚本需确认' }

// 远程 clean 但未认证脚本降级为确认（等价于现 remote_not_certified 分支；
// script-uncertified 信号在未通过 isScriptCertifiedRemoteSafe 认证时产出。
// 按序先于下方 clean 放行规则——未认证脚本无论 remoteScriptRequiresConfirm 配置如何一律 ask）
{ id: 'script-uncertified-ask-remote', when: 'invocation',
  match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-uncertified'] },
  action: 'ask', reason: '未通过远程安全认证的脚本需确认' }

// 远程 clean 已认证脚本：消费 remoteScriptRequiresConfirm 配置（迁移门控语义保留为规则参数；
// 等价于现 shouldSkipRemoteScriptConfirmOnAllow：安全迁移完成且配置为 false 才 skip，默认确认）
{ id: 'script-clean-certified-remote', when: 'invocation',
  match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['clean'] },
  action: 'ask', askUnless: { config: 'remoteScriptRequiresConfirm', equals: false, andMigrationComplete: true },
  reason: '远程 clean 已认证脚本按 remoteScriptRequiresConfirm 配置决定是否确认（默认确认）' }

// 桌面 clean 脚本免确认（等价于现 verdict allow → needsConfirm = false 直接执行）
{ id: 'script-clean-allow-desktop', when: 'invocation',
  match: { lane: ['desktop'], toolName: 'run_script', signals: ['clean'] },
  action: 'allow', reason: '桌面 clean 脚本按现状免确认直接执行' }

// ===== 规范条目结束 =====

// 桌面自动审批入口（第 4 步段，规范排序定死位于六条脚本规则之后）。
// match 收窄到现状等价域（toolChatLoop.ts:1032-1036）：仅桌面 + 仅 write_file/edit_file +
// confirmMode=auto 配置前置；auto-evaluator 命中不产生 Decision，评估器不裁决则续走后续规则（约定 2）。
// 向其他工具/链路泛化属可见变化，走 §11 演进口径。
{ id: 'desktop-auto-approve', when: 'invocation',
  match: { lane: ['desktop'], toolName: ['write_file', 'edit_file'] },
  action: 'auto-evaluator', configRequires: { config: 'confirmMode', equals: 'auto' },
  reason: '桌面 confirmMode=auto 时写/编辑文件的自动审批' }
```

**默认规则 schema 对顶层设计 `PolicyRule` 类型的实现层扩展**（需同步回顶层设计扩类型；同步前先在实现层 schema 落定义并注明对应关系）：

- `action` 枚举增 `'auto-evaluator'`（顶层设计 §3.5 现仅 `deny | allow | ask`），承载第 4 步自动审批器入口；其命中不产生 Decision 的续走语义见约定 2；
- 规则 schema 增 `askUnless` 条件字段。`askUnless.andMigrationComplete` 是**参数化的配置引用**，不是策略层读运行时状态——策略层仍保持纯函数，迁移完成位与配置值作为输入参数随规则求值上下文传入；
- 规则 schema 增 `configRequires` 配置前置字段（如 `desktop-auto-approve` 的 `confirmMode === 'auto'`），与 `askUnless` 同为参数化配置引用模式，配置值作为求值输入传入；
- 规则 schema 增 `requiresContext` 上下文前置字段（如 `remote-write-grant-allow` 的 `remoteWriteGrantValid`），消费 ExecutionContext 中由执行链路注入的只读事实（grant 有效性/余量）；
- `match.toolName` 支持字符串或字符串数组两种形态（如 `desktop-auto-approve` 的 `['write_file','edit_file']`），数组语义为"任一命中"。

带状态控制流的归属（两条现状机制，同一种拆法——**读进上下文，记账留链路**）：

- **出站写预算门控**：`outboundWriteBudgetRemaining` 进 ExecutionContext，由一条纯函数规则消费；`recordOutboundWrite` 留在执行链路，判定通过后执行。预算耗尽映射为 require-confirm 的变体，通道返回 `approved-with-action`：继续 = 提额续跑 / 回桌面 = 转桌面链路处理 / 停止 = 撤销任务，与现状三选交互（`toolChatLoop.ts:2109`）逐项等价，写进 P1 验收。**IM 侧路由定稿：用户的"继续"仍走现状路径——下一条入站消息由 remoteTaskController 的 budgetPaused 态处理，不改走 `parseImConfirmReply`**；`approved-with-action` 只是通道返回值的语义映射，IM 侧交互路径零变化，避免 P1 重造交互。
- **远程写授权 grant**：grant 的"读"（是否有效、`remainingOps`/`remainingBytes` 余量）进 ExecutionContext，由 `remote-write-grant-allow` 规则条目消费（定序先于 `im-write-ask`，见上方规则清单）；`reserve`（扣减额度）、`isRequestLeaseOwner` 租约校验、`authorizationGeneration` 代际校验全部留在执行链路，判定通过后执行。**`issue` 的时机同样定死：首笔远程写确认批准后立即签发 session 级 grant、与当次 `reserve` 同回合完成**（现状 `toolChatLoop.ts:1498-1504`："First remote write confirm issues a session-scoped write grant, then reserves this op"）。上述校验与 issue/reserve 必须紧贴工具执行、与执行同一同步段完成，见 §5.5 的同步段不变量。`remoteWriteGrantRegistry` 本体保留不动，**不迁为缓存条目**——它是带记账的有状态授权，不是"用户回答的复用"，布尔语义的 `decision_cache` 装不下它。

**exposure 时机**同时落地，且主进程是唯一评估者：

- 主进程 `toolsConfigRuntime.ts` 的 if 链（shell 未启用滤 run_shell、feishu 未启用滤 lark 工具、remote 滤 wechat_send 等）逐条改写为 exposure 规则条目，由同一个规则匹配器消费。因策略（而非普通开关）过滤掉的条目落 `policy.deny-exposure` 审计事件。
- 渲染进程不再维护镜像 if 链：exposure 过滤依赖运行时配置（deniedTools、启用开关都在主进程 DB），纯共享包导入接不住。定稿方案为——**主进程评估后把生效工具清单经 IPC 推给渲染进程**（配置变更时重推），`src/shared/toolsConfigFilter.ts` 改为消费这份清单的薄壳。两条 if 链漂移的问题由此连根消除，而不是换个形态复活。**启动时序定稿：渲染进程就绪/订阅时主进程先推一次全量清单**（现状 `ChatView.tsx` / `chatToolSessionService.ts` 是同步调用 `filterBuiltinToolsForRenderer`，薄壳化后首推到达前的空窗期按"渲染端缓存最近一次清单、冷启动空窗内工具列表暂不渲染"处理，避免出现工具列表闪空）。

### 5.2a ingress 评估点（消息入口准入）

ingress 发生在 IM 消息入口、创建任务之前，**此时没有 toolInput，也没有 ContentFacts**——它不进 `toolChatLoop`，是策略层的第二个接线点：

- **输入形态**：`IngressFacts`（lane + origin），由 IM 链路适配器在收消息时产出。**发送者白名单（现 `remoteSenderAllowlist`）由分类器吸收**：适配器先查白名单——名单内发送者归 `direct-owner` 并填 `senderId`，名单外归 `direct-other`（由 ingress 规则拒绝）；规则只按 origin kind 匹配（`PolicyRule.match` 没有也不需要 sender 列表维度），白名单数据本身作为链路适配器的配置保留。**微信与飞书同样消费白名单**（现状 `weChatCommandRouter.ts:126` 经共享的 `evaluateImInboundGuard` 校验 `config.remoteSenderAllowlist`，`weChatIpc.ts:271-272` 绑定后把 `boundUserId` 回填进白名单；名单为空或不含发送者 → `not_owner` 不响应）；两链路的差异仅在**微信无 group 维度**，飞书按会话类型区分单聊/群。顶层设计 §3.1 的论据需同步修正：不是"微信只能绑定本人"，而是"白名单默认回填为绑定用户，可多用户"。
- **评估位置**：微信/飞书的入站消息 handler（现状 `remoteSenderAllowlist` 检查所在的位置），在创建会话任务之前调用 `decideIngress`；deny 即不响应（现状行为），并落 `policy.deny-ingress` 审计事件。
- **验收**：P2 增加"allowlist 拦截行为逐项等价"回归（白名单内/外发送者、单聊、各链路的响应/不响应与迁移前一致）。

### 5.3 决策缓存（`electron/confirmation/decisionCache.ts`）

**P1–P3 的衔接设计（关键）**：策略层从 P1 起就面向 `DecisionCacheView` 只读接口编程，存储实现分两期替换：

- **P1：`LegacyExemptionAdapter`**——包住四类存量存储（`shellConfig.trustedCommands`、`browserConfig.trusted*`、`actSessionTrustEnabled` 内存态、MCP 会话信任内存态；grant 不在其中，见 §5.2），对策略层暴露统一的 `lookup(key): DecisionCacheEntry | null`。签名规范化逻辑（子命令 token、域名、路径分类 → 规范化键）就落在这一层，P1 的变体绕过测试集测的就是它。
- **P3：`SqliteDecisionCache`**——新建 `decision_cache` 表，存量数据一次性迁移进来；适配器删除。接口不变，策略层与主循环零改动。
- **两期都跑变体绕过测试集**：P1 测适配器的签名规范化，P3 测 `decision_cache` 键的规范化，防止换存储时规范化逻辑漂移。

表结构：`id, key_json, decision, lane, scope, source, created_at, last_hit_at, hit_count, expires_at`，对 `key_json` 建索引。

迁移映射（四类进缓存，grant 单独保留）：

| 现状 | 存储位置 | 迁移目标 |
|---|---|---|
| shell 信任命令 | `shellConfig.trustedCommands` | `shell-command` 键，按现有粒度定 level |
| 浏览器域名信任（持久） | `browserConfig.trustedDomains / actTrustedDomains` | `domain` 键，persistent |
| 浏览器域名信任（会话级） | `actSessionTrustEnabled` 相关内存态 | `domain` 键，scope=session |
| MCP 会话信任 | 内存 | `mcp-tool` 键，scope=session |
| 远程写授权 grant | `remoteWriteGrantRegistry` | **不迁移**（带额度记账 + 租约语义，按 §5.2 读写拆分保留本体） |

会话级条目的失效设计（补上"内存态迁 SQLite 后不退化成永久条目"这一环）：

- **会话删除时**：删除该 sessionId 的全部 session 条目（挂在现有会话删除流程上）。
- **应用启动时**：清理所有 session 条目——内存态的原有语义就是"进程消亡即失效"，启动清理与之等价且实现最简。
- 两条都写成迁移验收用例。

其他规则：TTL 按风险分级（execute 类 90 天，低风险无 TTL）+ 180 天未命中休眠；跨链路（`lane:'*'`）条目一律设 TTL（最长 365 天）；失效后命中先重走策略层，判断不了才问用户；"仅此一次"不落库；换绑/重置（现授权代际）= 清空该链路全部条目（落 `cache.generation-reset` 事件）；策略层只读缓存，**写缓存由执行链路在用户回答后完成**（含拒绝方向的 deny 条目；`approved-with-action` 与 `timeout` 不写缓存）。

**run_script 的记忆封顶（P3 口径定死）**：携带 `script-network` 或 `script-uncertified` 信号的调用**强制"仅此一次"、不开放任何记忆档位**——这两条规则（`script-network-ask-desktop`、`script-uncertified-ask-remote`）均非 locked、位于缓存检查之后，若开放记忆，"记住"会绕过网络命中确认与未认证降级（`remoteScriptRequiresConfirm=false` 时同理），属安全松动。P3 验收条目"危险操作封顶 exact"据此点明：脚本类调用的网络/未认证信号适用比 exact 更严的"仅此一次"封顶，并列入 P3 发布说明。

### 5.4 确认通道（`electron/confirmation/channels/`）

**DesktopChannel**：薄包装 `toolConfirmRegistry` + 现有 `tool:confirm-request` / `tool:confirm-response` IPC。确认卡片的"信任"勾选改为范围选择器（MemoryTier 列表），默认选中最窄档；这属于 P3/P4 的可见变化，P1 阶段保持现有交互不变（通道内部把旧的"信任"勾选映射到对应的固定档位）。

**ImChannel**：合并 `feishuConfirmManager` + `weChatConfirmManager` 为一个类，按链路参数化三件事：发消息的函数、文案模板、超时默认值。保留：

- `PendingRequestRegistry` 复用不动；
- `parseImConfirmReply` 扩展 `记N <id>` 协议（编号对应 memoryTiers 顺序，消息里必须内嵌每档的人类可读描述，超出 IM 表达力的档位只在桌面开放）；
- `allocateConfirmId` 短号机制不动，**短号同时充当审计事件的 `requestId`**，确认请求与回答在日志里可关联；
- `resolveFromDesktop`（桌面代答）能力保留为通道接口的可选方法；
- 预算耗尽的三选交互：**通道返回值语义映射、两侧交互路径零变化**——IM 侧维持现状纯文本提示（`（继续 / 回桌面 / 停止）`，`toolChatLoop.ts:2109-2112`），"继续"仍由 remoteTaskController 的 budgetPaused 态处理（§5.2）；桌面侧维持现状交互。`approved-with-action` 仅是通道返回值的语义映射，不在本期引入编号选项文本协议或三按钮卡片（如后续要做，属用户可见变化，另立阶段）。

对外只暴露 `ConfirmationChannel` 接口；`remoteConfirmBridge.ts` 的两个对称工厂删除，改为 `new ImChannel(lane, deps)`。

**P1 过渡态：`LegacyImChannel` 薄包装**。主循环在 P1 就要改成 `channelFor(context.lane)` 统一分发并删除远程/桌面双分叉，这意味着 IM 链路在 P1 就必须有通道实现，不能等 P2 的 ImChannel。P1 因此交付一个薄包装：包住现有 `remoteConfirmBridge` 两个工厂（内部仍走两个 ConfirmManager），行为零变化，只补两件事——实现 `ConfirmationChannel` 接口供主循环统一调用；在请求/回答处发 `confirm.request` / `confirm.outcome` 审计事件。P2 的 ImChannel 合并即"用合并实现替换 LegacyImChannel 并删除两个 ConfirmManager"，验收不变。

### 5.5 主循环瘦身（`electron/toolChatLoop.ts`）

重构后主循环里确认相关的代码收敛为一段直线流程（目标从约 500 行降到约 80 行）：

```ts
const context = buildExecutionContext(remoteContext, session, budgets, grant); // 1. 组装
const facts = await runExtractors(descriptor, toolInput, envFacts);            // 2. 提取
const decision = policyEngine.decide(facts, context, rules, cacheView);        // 3. 判定
audit.decision(context, facts, decision);                                      // policy.decision 事件（异步，不阻断）

switch (decision.type) {
  case 'auto-allow': recordSideEffects(decision); break;   // 记账在执行链路（预算/grant reserve）
  case 'deny': pushToolError(decision.reason); continue;
  case 'require-confirm': {
    const outcome = await channelFor(context.lane).request(buildConfirmRequest(decision));
    // confirm.request / confirm.outcome 事件由通道内部以同一 requestId 落
    if (outcome.kind === 'approved-with-action') { handleBudgetAction(outcome.action); continue; }
    // 只有 approved/rejected 才是"该不该允许"的用户回答，才写缓存；
    // approved-with-action / timeout 不写
    await cacheManager.recordUserAnswer(decision, outcome);
    if (!isApproved(outcome)) { pushToolError(...); continue; }
  }
}
// 4. 执行工具（原有逻辑不动）——远程链路在执行前一刻进入"同步授权段"（见下方不变量）
```

**同步授权段不变量（硬性，写进 P1 验收）**：现状远程确认路径在用户答 Y 之后**同步、同回合**完成租约/代际校验与 grant 记账（`toolChatLoop.ts:1470` 注释明示 "no await between check and execute"），这是刻意防 TOCTOU 的设计——IM 确认等待期间发生换绑/撤销/租约转移时，回答回来后必须在执行前一刻同步复核。新流程必须保住它：

- **租约归属校验（`isRequestLeaseOwner`）、代际校验（`authorizationGeneration`）、grant `issue`（首笔批准后签发 session 级 grant）+ `reserve`、grant 侧预算记账，必须紧贴工具执行、与执行同一同步段完成；缓存写入（`recordUserAnswer`）与审计事件发射均不得插入其间。**
- 上面伪代码中 `await cacheManager.recordUserAnswer(...)` 位于同步授权段**之前**；回答回来之后、执行之前不再穿插任何 await（缓存写入如确需在执行后补记，也不得拆开校验与执行）。

被删除的内联逻辑的去向，每一处都要在迁移 checklist 里打勾（含 `:917` 远程阻断、`:958` 预算门控、`:1022` shell 预检、`:1156` 文件 auto、`:1280` 确认基线、`:1291-1439` 各覆写、`:1441-1662` 双分叉），不允许出现"主循环里还留着一条没迁"。

**用户可见提示的归属（P1"无用户可见变化"兜底）**：现状桌面 browser act 在"已信任域名 + 非高危 + 免确认"时会 `sendProgress('trust_auto_approved', ...)` 发用户可见提示（`toolChatLoop.ts:1794-1818`）。新流程里该路径变成缓存命中 auto-allow，**该进度提示保留在主循环的 auto-allow 分支（缓存命中且 lane=desktop、工具为 browser act 时发出），不归通道也不归缓存层**，写进迁移 checklist 与 P1 验收。

### 5.6 安全审计日志（`electron/confirmation/securityAuditLog.ts`）

确认框架是安全模块，审计日志是证据链本体。实现对照现有飞书/微信 CLI 日志模式（按日切分 JSON Lines、`sanitizeForLog` 脱敏），六条硬性要求逐条落地：

1. **独立文件，物理隔离**：`SecurityAudit-{YYYYMMDD}.log`，目录与 Agent 日志相同（开发 `{项目根}/logs/`、打包 `{workDir}/.agent/logs/`），绝不混入功能日志。保留天数默认 180 天，设置页可调；清理时机两处：启动时 + **每天按日切分写新文件时顺带检查一次过期文件**（桌面应用可能连续运行数日，不能等重启才清理）。
2. **判定即记录**：`deny`、`require-confirm`、`confirm.outcome`、全部 `cache.*` / `settings.*` 事件**必落**；`auto-allow` 属常规放行，降级为 debug 级采样（默认不逐条落，设置页可开）。**安全不变量被触发的路径（硬约束先于缓存命中拦截、危险信号封顶 exact 档）必须可从日志复现**——这两条写成专门的审计测试用例。
3. **落事实不落内容**：事件只携带 `factsSummary` 与信号 kind 列表；命令签名/缓存键一律取规范化签名文本（与缓存键同源，日志与缓存可对账）；写入前经 `sanitizeForLog` + 安全审计字段规则脱敏，不落用户消息正文、token、secret、API Key。
4. **记录不阻断执行**：异步缓冲批量落盘；写失败降级为一条 agentLogger 错误并重试，**判定路径不依赖日志写入成功**。策略层保持纯函数不发事件——事件由执行链路侧在拿到判定结果后发出（与"写缓存在执行链路"同侧）。
5. **确认交互全程留痕**：`confirm.request` / `confirm.outcome` 以同一 `requestId`（确认短号）关联；超时、桌面代答、IM `记N` 选择落 `confirm.outcome` 扩展字段。**口径定稿：预算三选（`approved-with-action`）不落 `confirm.outcome`**——它是额度决策不是"该不该允许"的回答，其结局（续跑/回桌面/撤销）只记在 `budget.exhausted` 事件的扩展字段；`SecurityAuditEvent.outcome` 枚举因此保持 `approved | rejected | timeout | cancelled` 四值不加新成员。
6. **配置变更必记**：套餐切换、规则动作/参数修改、链路硬约束启停（`settings.policy-change`）、deniedTools 变更（`settings.tool-toggle`）、确认记忆清除（`cache.clear`），逐条落事件并记录新旧值。

**分期窗口期声明**：`cache.*` 事件 P3 才落地，意味着 P1/P2 期间 `LegacyExemptionAdapter` 的信任命中不落 `cache.hit`；`settings.*` 事件 P4 才落地，意味着存量 Shell/Browser Tab 里的信任增删在 P4 前不落 `settings.*`。"全部 cache/settings 事件必落"是 P4 完成后的目标态口径；P1–P3 期间验收按当期分期落点执行，不以目标态口径卡中间阶段。

事件发射点分工：

| 发射点 | 事件 |
|---|---|
| 主循环（拿到 Decision 后） | `policy.decision`、`budget.exhausted`（含续跑/回桌面/撤销结局） |
| IM 入站 handler | `policy.deny-ingress` |
| exposure 评估处（主进程） | `policy.deny-exposure`（仅因策略过滤的条目，普通开关不记） |
| 通道（DesktopChannel / ImChannel） | `confirm.request`、`confirm.outcome` |
| 缓存管理器 | `cache.hit` / `cache.write` / `cache.clear` / `cache.expire-dormant` / `cache.generation-reset` |
| 设置处理器（IPC handler） | `settings.policy-change`、`settings.tool-toggle` |
| 迁移脚本 | `migration.*`（信任数据迁移逐条记录） |

与既有审计渠道的关系：飞书/微信的 `feishu-audit.log` / `wechat-audit.log` 是 IM 操作审计，继续存在，互不替代。

## 6. 数据与配置迁移

- `schema.ts`：`DB_SCHEMA_VERSION` 3 → 4（本方案基于产物移除计划落地后的 v3，见 §1.3；若届时实际版本再变，按实际顺延并在实施前核对），新增 `decision_cache`、`policy_rules`（用户覆盖的规则动作/参数）两表；`migrations.ts` 加一级 `if (version === 3)`，沿用现有逐级 if 链模式。
- 配置迁移沿用 `remoteSecurityConfigVersion` 版本门控先例：新版本号下，启动时把 `shellConfig.trustedCommands`、`browserConfig.trusted*`、`RemoteImCommonConfig` 的确认字段一次性搬迁进新表/新结构，旧字段保留只读（不物理删除历史值），deprecated 字段（`resolveRemoteConfirmPolicy`、`wechatSendRequiresConfirm`、`remoteWechatConfirm` 等）随对应阶段顺手清理代码引用。
- 迁移失败的兜底：搬迁脚本每一步可重入（幂等），失败时保持旧路径可用并记录日志，不阻塞启动。迁移过程逐条落 `migration.*` 审计事件。

## 7. 设置中心（渲染进程，P4）

新增"工具与安全"设置页，**五区**（对应顶层设计 §4 现状）：

1. **策略套餐**：每条链路选套餐（严格/标准/宽松/自定义）；自定义套餐只能编辑每条规则的动作（拒绝/允许/询问）与参数（超时、适用链路），规则不可增删、顺序不可改；locked 条目只读。链路硬约束的启停是独立开关（沿用 `remoteAllowLocalWrite` 语义），带风险警示与二次确认。
2. **确认模式**：现有 diff/direct/auto 原样搬入。
3. **工具开关**：现有 deniedTools 交互原样搬入。
4. **确认记忆管理**：`decision_cache` 统一列表（来源、作用域、链路、命中次数、按档位分组展示），支持清除——清除即"下次再问"。取代 Shell/Browser Tab 里散落的信任管理 UI。
5. **安全审计记录**：只读查看安全审计日志（按时间/链路/事件类型/工具过滤），以及保留天数设置；清除确认记忆等操作在此同样留痕。

旧 Tab（Browser/Shell/RemoteImCommon）中的确认项改为跳转到新设置页的快捷入口，读写同一份配置。所有文案走 i18n（新增命名空间 key 后跑 `npm run i18n:generate-types` 与 `npm run i18n:check`）。

## 8. 分期实施

| 阶段 | 内容 | 验收要点 |
|---|---|---|
| **P0 概念收敛** | 落 `src/shared/confirmation/types.ts` 全部类型（含 `SecurityAuditEvent`）；`builtinToolDefinitions.ts` 补元数据；`builtinToolNeedsConfirmation`/`builtinToolRiskLevel` 改为读元数据（对外行为不变） | `npm run typecheck:shared` 通过；现有测试全绿；无用户可见变化 |
| **P1 策略引擎** | 提取器迁移（按 §5.1 信号档位映射表，含脚本分析 lane 分叉与 `script-network` / `script-uncertified` 信号）+ `policyEngine`（含 `decideIngress` 骨架与 desktop-only 自动审批规则）+ 主循环瘦身 + 预算门控与 grant 读写拆分 + LegacyExemptionAdapter + 审计日志模块与判定/确认类事件 + **`LegacyImChannel` 过渡包装**（包住现有两个 ConfirmManager，实现 `ConfirmationChannel` 接口并落 `confirm.*` 事件，IM 确认行为零变化；主循环由此得以删除双分叉、统一 `channelFor` 分发）。**末尾独立子阶段**：exposure 规则化 + 渲染端 IPC 化（主进程 if 链先改规则评估，IPC 下发随后，失败可回退半步、单独发布） | 主循环确认相关代码 ≤80 行；迁移 checklist 全打勾；变体绕过测试集（适配器落点）通过；**四类豁免经适配器查询后行为与迁移前逐项等价**；**browser act 高危关键词仍走确认（不升级为拒绝）**；**同一含网络访问脚本"桌面问、远程拒"对照等价**；**桌面 clean 脚本免确认、远程 clean 已认证按 `remoteScriptRequiresConfirm` 配置、远程 clean 未认证必确认，三态逐项等价**；**browser / run_shell 链路不受脚本规则波及**（远程 browser navigate 默认免确认、远程 browser act 走确认、远程 run_shell 网络命令按模式判定，迁移前后逐项不变）；预算耗尽三选交互（继续/回桌面/停止）行为等价；**同步授权段不变量成立**（租约/代际校验、grant issue+reserve、预算记账与工具执行同一同步段，缓存写入与审计发射不插入其间）；**browser act 信任自动放行的 `trust_auto_approved` 进度提示保留**；**`policy.decision` / `confirm.*` / `budget.exhausted` 事件必落**；无用户可见变化 |
| **P2 IM 通道合并** | ImChannel 合并飞书微信（**替换 P1 的 LegacyImChannel**，删除两个 ConfirmManager 文件）；超时入策略表；origin 分类（分类器吸收白名单：**微信与飞书同样消费白名单**，名单内 direct-owner / 名单外 direct-other，差异仅在微信无 group 维度）；IM 入口接 `decideIngress` | ImChannel 替换后审计事件不中断（`confirm.*` 持续必落）；Y/N/信任协议、超时、桌面代答逐项回归；**allowlist 拦截行为逐项等价**（白名单内/外、单聊、各链路）；`policy.deny-ingress` 事件必落；无用户可见变化 |
| **P3 缓存统一** | `decision_cache` 表 + SqliteDecisionCache 替换适配器 + 四类豁免迁移（逐条落 `migration.*`）+ 会话级条目清理钩子 + 确认卡片"记住"范围选择器 + IM `记N` 协议 | 迁移幂等可重入；老用户的信任命令/域名信任升级后照常生效；变体绕过测试集（decision_cache 落点）复跑通过；session 条目在会话删除与应用启动后正确失效；范围选择器默认最窄档、危险操作封顶 exact（含 `script-network` / `script-uncertified` 信号的脚本调用强制"仅此一次"，见 §5.3）；**`cache.*` 事件必落** |
| **P4 设置中心** | 新"工具与安全"页（五区）+ 确认记忆管理 + 审计记录只读查看与保留天数设置 + 旧入口改快捷链接 + **CLAUDE.md 排障章节补 `SecurityAudit-{YYYYMMDD}.log` 说明**（位置、脱敏规则、与 feishu/wechat-audit.log 的分工，对照飞书/微信 CLI 日志先例） | 旧配置项在新页读写一致；**`settings.*` 事件必落（含新旧值）**；i18n check 通过；CLAUDE.md 排障说明补齐 |

每期独立可发布；P0/P1/P2 的验收标准是"行为可回归、无用户可见变化"，P3/P4 引入的可见变化逐项列入发布说明。

## 9. 测试计划

- **纯函数密集单测**（policyEngine 双入口、提取器、缓存键规范化、TTL）：放 `src/shared/policy/*.test.ts` 与 `electron/confirmation/**/*.test.ts`，node 环境。**策略层与默认规则的测试一律以字面量注入 EnvFacts，不得 mock Electron/Node 环境对象**。
- **行为等价回归**：P1 动手前先给 `toolChatLoop` 现有 8 个决策点补齐"判定输入 → 是否确认/拒绝"的表驱动用例（该段已有 `toolChatLoop.shell/phase2RemoteConfirm/wechatOutboundConfirm/outboundBudget` 等测试基础，在此基础上扩展），重构后同一批用例必须全绿。专项对照：豁免等价性（适配器）、allowlist 等价性（ingress，**含微信白名单内/外发送者**）、**browser act 高危关键词（现状确认 → 迁移后仍确认）**、**脚本分析 lane 分叉（同一含网络访问脚本：桌面走确认、远程直接拒绝；远程 clean 未认证走确认、已认证按 `remoteScriptRequiresConfirm` 配置；桌面 clean 免确认）**、**脚本规则作用域对照（远程 browser navigate 仍默认免确认、远程 browser act 仍走确认、远程 run_shell 网络命令仍按模式判定——证明 `script-network` / toolName 双重限定没有把 browser / run_shell 的通用 `network-egress` 卷进脚本规则）**；**多信号组合裁决（规则匹配为包含语义 + 数组顺序首中即出）：clean+script-network（桌面 ask / 远程 deny，不被 clean 放行规则抢先命中）、clean+script-uncertified（远程 ask，即使 `remoteScriptRequiresConfirm=false`——未认证一律问，禁止 clean 免认证放行）**；**自动审批器截胡对照：桌面 `read_file` 不因 `desktop-auto-approve` 出现确认；`confirmMode=auto` 下桌面 clean 脚本仍免确认（证明规则顺序 + auto-evaluator 续走语义没有被评估器截断）**。
- **变体绕过测试集**（P1、P3 双落点验收硬项）：shell exact 档签名规范化必须覆盖 `FOO=1 cmd`、`cd x && cmd`、引号/空白变体——这些不得命中缓存。
- **通道回归**：ImChannel 合并后跑原 `weChatConfirmManager.test.ts` / `feishuConfirmManager.test.ts` 用例改造版（Y/N/信任/超时/桌面代答/文案差异/预算三选）。
- **渲染端 exposure 测试改造**：`toolsConfigFilter.ts` 改为 IPC 清单薄壳后，现有纯函数过滤测试改为"消费主进程清单"的验证用例（清单驱动渲染，不再自算）。
- **迁移测试**：构造带旧版配置/信任数据的 DB，升级后逐项核对缓存条目与规则覆盖；模拟迁移中断验证幂等重入。
- **审计日志三类专项**：
  1. **事件完整性**：deny / require-confirm / confirm.outcome / cache.\* / settings.\* 必落；安全不变量路径（硬约束先于缓存拦截、危险信号封顶 exact）可从日志逐条复现。
  2. **脱敏**：构造含用户正文、token、secret 形态的输入，断言日志中不出现；命令签名与缓存键同源可对账。
  3. **故障不阻断**：注入日志写故障，断言工具判定结果与确认流程不受影响（仅降级记 agentLogger 错误）。
- 执行策略按 AGENTS.md：开发期只跑定向测试（`npm exec vitest run <file>`），Phase 收尾与最终验收才跑全量 `npm test`。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 与「移除产物管理」计划撞车（schema 版本、同批文件、基线漂移） | §1.3 定稿产物移除先行；本方案 schema 3→4、基线以移除后代码为准，P0 启动前重核行号；artifact 决策流显式排除出迁移范围 |
| 脚本分析丢失 lane/认证维度，照字面实现即安全回归或验收失败 | §5.1 映射表按链路分叉列逐格定死（含 allow 行三态）；网络命中产独立 `script-network` 信号、未认证产 `script-uncertified` 信号，由规则按 lane 消费；"同一脚本桌面问、远程拒"对照用例进 P1 验收 |
| 脚本规则作用域外溢，把 browser / run_shell 的通用 `network-egress` 卷进 locked 硬拒绝或强制确认 | 脚本规则双重限定（独立信号 `script-network` + `toolName: 'run_script'`）；远程 browser navigate / act、远程 run_shell 网络命令迁移前后不变的对照用例进 §9 回归与 P1 验收 |
| 远程确认的 TOCTOU 防护在重构中丢失（校验与执行之间插入 await） | §5.5 同步授权段不变量写明并进 P1 验收；行为等价回归覆盖换绑/撤销场景 |
| P1 瘦身时漏迁某条内联判断，行为悄悄变化 | 迁移 checklist 按 §2 的 8 个散布点逐条打勾；先补行为等价测试再动手 |
| P1 上了策略链但缓存还是空的，存量豁免静默失效 | LegacyExemptionAdapter 作为 P1 组成部分；豁免逐项等价进 P1 验收 |
| grant 被当成布尔豁免迁移，丢失额度/租约语义 | 明确不迁移，读写拆分保留本体 |
| 现状判定与新信号档位对不上，实现时临场裁决 | §5.1 映射表逐条定死；browser act dangerous 裁决为 `suspicious`，专项回归兜底 |
| 缓存键签名不严，构造变体绕过信任 | 签名只取事实的结构化字段（子命令 token、域名、路径分类）；变体绕过测试集两期双落点 |
| 桌面 confirmMode=auto 经泛化审批器渗到远程链路 | 自动审批规则固定 `lane:['desktop']`，与现状 `!remoteContext` 严格等价 |
| 飞书微信差异（绑定 owner、发送者白名单、群聊）在合并时被抹平 | 差异收敛到 origin 分类器（白名单由分类器吸收）与链路参数；allowlist 等价回归进 P2 验收 |
| 会话级缓存落库后退化成永久条目 | 会话删除 + 应用启动两条清理路径，写进 P3 验收 |
| 日志写入故障影响主流程 | 异步缓冲批量落盘 + 写失败降级 agentLogger 并重试；判定路径不依赖日志成功；故障注入测试兜底 |
| P1 体量过大，一处卡住全线停滞 | exposure 规则化 + 渲染端 IPC 化拆为 P1 末尾独立子阶段，可单独发布、失败回退半步 |
| 设置中心一次性改动面太大 | P4 与 P0–P3 解耦，旧入口保留为快捷链接，用户有适应期 |

## 11. 与后续迭代的接口预留

- automation 链路：lane 值、约束类型、`declaredCapabilities`、套餐模型均已定义；接入时按顶层设计 §5.3 清单走，零新增策略代码。
- 沙箱/提权：`allowElevation`、`sandbox-escape` 信号以 reserved 落类型；PathZone 四分类保持独立，沙箱位置将来作为第二维度叠加，本方案不涉及。
- 智能判断演进：策略层第 4 步"自动审批器"是唯一替换点，接口（输入 facts、输出 allow/confirm/deny + reason）本期固定下来，后续可换成启发式或模型辅助实现而不动主循环与通道；向其他链路开放 auto 审批属可见变化，届时走设置中心发布。

## 12. 修订记录

### v7 → v8（对应评审 v8）

- **B1（`desktop-auto-approve` lane-only 匹配 + `auto-evaluator` 在"首条命中即返回"机制下截胡桌面全部调用）**：三处修订——① 裁决机制约定补唯一例外条款（约定 2）：`auto-evaluator` 命中不产生 Decision，评估器裁决通过才返回，不裁决则交还规则链续走后续条目（含第 6 步默认表），消除"命中即终局 vs 续走"两读歧义；第 4 步段落"评估不通过回落问用户"改写为"评估器绝不自行放行，不裁决时交还规则链裁决"。② `desktop-auto-approve` 的 match 收窄到现状等价域（`toolChatLoop.ts:1032-1036`）：补 `toolName: ['write_file','edit_file']` 工具域限定与 `configRequires: confirmMode=auto` 配置前置，规范排序定死位于六条脚本规则**之后**。③ §9 补两个截胡对照用例：桌面 `read_file` 不因该规则出现确认；`confirmMode=auto` 下桌面 clean 脚本仍免确认。
- **N1（数组顺序与 1→6 步骤链双口径未合一）**：新增约定 4——数组按步骤分段排序（`locked && deny` 属第 1 步段、`auto-evaluator` 属第 4 步段、其余属第 6 步段默认表），缓存检查与能力声明放行是引擎内嵌的固定步骤而非规则条目，两口径合一。
- **N2（grant 消费规则条目缺位）**：规则清单补 `remote-write-grant-allow` 示例条目（grant 有效且余量充足 → 远程写免确认，等价于现状额度内直接 reserve 执行），定序先于 `im-write-ask`；schema 扩展同步补 `requiresContext` 上下文字段；§5.2 grant 段落改为点名该规则消费。
- **N3（run_script 记忆封顶未明确）**：§5.3 新增"run_script 记忆封顶"段——含 `script-network` / `script-uncertified` 信号的调用强制"仅此一次"、不开放记忆档位（两条对应规则非 locked、位于缓存之后，开放记忆即绕过网络确认/未认证降级）；§8 P3 验收同步点明。

### v8 遗留非阻断修订（4 条，不影响进入 P0）

- 约定 2 措辞消歧："评估器自身绝不放行"改为"未完成评估绝不放行"，消除与"裁决通过才返回 Decision"的字面矛盾。
- 约定 4 与清单排序合一：规则清单注明"按可读性分组呈现，`defaultRules.ts` 实际数组顺序按约定 4 分段组装"，`desktop-auto-approve` 位于脚本规则之后的口径以分段序为准。
- 约定 3 补例外：带 `requiresContext` / `configRequires` 门控的条件放行条目（门控不满足即不命中）可先于同域 ask 条目排列，承载 `remote-write-grant-allow` 先于 `im-write-ask` 的定序。
- schema 扩展补第五处：`match.toolName` 支持字符串或字符串数组（数组语义"任一命中"）。

### v6 → v7（对应评审 v7）

- **B1（脚本规则族优先级机制未定义且自相矛盾）**：§5.2 新增"规则匹配与裁决机制"三条约定定死——`signals` 匹配语义为**包含**（所列信号全部出现即命中）；规则优先级 = **数组顺序、首条命中即返回**（无"更具体优先"等其他机制）；同匹配域内**安全规则先于放行规则**排列。脚本规则族按规范顺序重排为 `script-network-deny-remote` > `script-network-ask-desktop` > `script-uncertified-ask-remote` > `script-clean-certified-remote` > `script-clean-allow-desktop`，删除与列举顺序矛盾的"优先级高于上一条"注释（该语义改为由排列顺序承载）。§9 回归补两个组合裁决用例：clean+script-network（桌面 ask / 远程 deny）、clean+script-uncertified（远程 ask，即使 `remoteScriptRequiresConfirm=false`）。
- 非阻断 1（规则 schema 超出顶层设计类型）：§5.2 补"默认规则 schema 对顶层设计 `PolicyRule` 的两处实现层扩展"说明——`action` 枚举增 `auto-evaluator`、规则增 `askUnless` 条件字段，需同步回顶层设计扩类型；`askUnless.andMigrationComplete` 注明为参数化的配置引用（迁移完成位作为输入传入），策略层保持纯函数不读运行时状态。
- 非阻断 2（脚本规则族以"举例"呈现但实为验收裁决依据）：§5.2 明确六条脚本规则（连同其顺序）为**规范条目**、P1 等价验收的裁决依据不得自由调整，其余条目保持示例。

### v5 → v6（对应评审 v6）

- **B1（脚本规则作用域外溢）**：三条脚本规则的 match 双重限定——网络命中改用脚本专属信号 `script-network`（与 browser / run_shell 共享的通用 `network-egress` 明确区分）且补 `toolName: 'run_script'`；§5.1 提取器行与映射表网络行同步改写；§9 回归与 §8 P1 验收补"远程 browser navigate 默认免确认、远程 browser act 走确认、远程 run_shell 网络命令按模式判定，迁移前后逐项不变"对照用例；§10 风险表补对应行。
- **B2（映射表 allow 行未定死）**：删除"按确认基线判定"表述；allow 行逐格定死——桌面列 `auto-allow`（等价于现 `needsConfirm = false` 直接执行），远程列拆两态（clean + 已认证 → 消费 `remoteScriptRequiresConfirm`，迁移门控语义保留为规则参数；clean + 未认证 → ask）；§5.2 补 `script-clean-allow-desktop` / `script-clean-certified-remote` 两条默认规则条目；§8 P1 验收补"三态逐项等价"。
- 非阻断 1（§5.4 预算三选口径残留矛盾）：§5.4 统一为"通道返回值语义映射、两侧交互路径零变化"——IM 侧维持纯文本提示 + budgetPaused 路由，桌面侧维持现状；编号选项文本协议 / 三按钮卡片明确不在本期。
- 非阻断 2（`match.facts` 维度未定义）：认证态改为信号表达——未通过认证时产 `script-uncertified` 信号，规则按 `signals: ['script-uncertified']` 匹配，与顶层设计 §3.5 `PolicyRule.match` 类型对齐（不扩 `facts` 字段）；§5.1 提取器行、映射表认证行、§5.2 规则条目、§8 P1 内容同步统一为信号形态。

### v4 → v5（对应评审 v5）

- **B1（与「移除产物管理」计划冲突）**：新增 §1.3 定稿执行顺序——产物移除先行、本方案基于移除后代码；§6 schema bump 调整为 3 → 4（`if (version === 3)`）；§2 基线口径声明"行号以产物移除后代码为准、P0 启动前重核"；artifact 写入决策流显式排除出迁移范围并备案；§10 风险表补对应行。
- **B2（脚本分析提取器丢 lane/认证维度）**：§5.1 提取器改为"模式级事实"——网络命中独立产 `network-egress` 事实、认证态独立产 `script-certified: boolean`；映射表重构为带"桌面链路规则 / 远程链路规则"分叉列，网络命中"桌面 ask / 远程 deny"与"远程 clean 未认证 → ask"逐格定死；§5.2 规则条目补 `script-network-deny-remote` / `script-network-ask-desktop` / `script-uncertified-ask-remote` 三条；§8 P1 验收与 §9 回归补"同一脚本桌面问、远程拒"对照用例。
- **B3（微信白名单语义自相矛盾）**：§5.2a 改为"微信与飞书同样消费白名单（名单内 direct-owner / 名单外 direct-other），差异仅在微信无 group 维度"，删除"微信恒 direct-owner"；顶层设计 §3.1"只能绑定本人"论据需同步修正为"白名单默认回填为绑定用户，可多用户"；§8 P2 内容同步改写。
- **B4（同步授权不变量缺位）**：§5.5 新增"同步授权段不变量"——租约/代际校验、grant `issue`+`reserve`、预算记账与工具执行同一同步段完成，缓存写入与审计发射不得插入其间，写进 P1 验收；§5.2 grant 段落补 `issue` 时机（首笔远程写确认批准后、与 reserve 同回合）；§10 风险表补 TOCTOU 行。
- 非阻断 1（预算三选 IM 路由）：§5.2 定稿——IM 侧"继续"仍走 remoteTaskController budgetPaused 路由，`approved-with-action` 仅为通道返回值语义映射，不改走 `parseImConfirmReply`。
- 非阻断 2（渲染端首推时序）：§5.2 补"渲染进程就绪/订阅时主进程先推一次全量清单"，空窗期按缓存最近清单处理，避免工具列表闪空。
- 非阻断 3（allow 行措辞）：§5.1 映射表 allow 行校准——桌面现状 verdict allow 即跳过确认，远程才由配置决定。
- 非阻断 4（`trust_auto_approved` 提示落点）：§5.5 点名——该进度提示保留在主循环 auto-allow 分支（缓存命中 + desktop + browser act），进迁移 checklist 与 P1 验收。

### v3 → v4（对应评审 v4）

- **B1（P1 通道过渡态未定义，P1 验收自相矛盾）**：P1 新增过渡交付物 `LegacyImChannel`——薄包装现有两个 ConfirmManager（经 `remoteConfirmBridge` 工厂），行为零变化，只做两件事：实现 `ConfirmationChannel` 接口供主循环统一 `channelFor` 分发、落 `confirm.request`/`confirm.outcome` 审计事件。P1 的"≤80 行 / 删双分叉 / `confirm.*` 必落"三项验收由此可同时满足；P2 语义改为"ImChannel 替换 LegacyImChannel"，验收补"审计事件不中断"。
- 非阻断 1（outcome 枚举口径）：定稿——预算三选（`approved-with-action`）不落 `confirm.outcome`，结局只记在 `budget.exhausted` 扩展字段；outcome 枚举保持四值。
- 非阻断 2（P1–P2 审计盲区）：§5.6 补分期窗口期声明——"全部 cache/settings 事件必落"是 P4 完成后的目标态口径，中间阶段按当期分期落点验收。
- 非阻断 3（保留天数清理时机）：§5.6 第 1 条补"每天按日切分时顺带清理过期文件"，覆盖连续运行跨保留期的场景。
- 非阻断 4（CLAUDE.md 排障章节）：列入 P4 内容与验收（SecurityAudit 日志位置、脱敏规则、与 feishu/wechat-audit.log 分工）。

### v2 → v3（对应评审 v2 + v3 补遗）

- **B1（v3，审计日志零覆盖）**：新增 §5.6 安全审计日志模块设计（独立文件、判定即记录、落事实不落内容、异步不阻断、确认留痕、配置变更必记，六条硬性要求逐条落地）；§3 目录表补 `securityAuditLog.ts`；§4 类型收录 `SecurityAuditEvent` 与事件族，**Decision 三分支补 `ruleId`**（同步回顶层设计）；§5.2/§5.2a/§5.5 补事件发射点；§7 设置中心改五区（补"安全审计记录"区）；§8 分期落点（P1 起判定/确认/预算事件，P3 起 cache.\*/migration.\*，P4 settings.\* + 查看界面）；§9 补事件完整性/脱敏/故障不阻断三类专项测试；§10 风险表补"日志写入故障影响主流程"。
- **B1（v2，信号档位映射缺口）**：§5.1 新增"现状判定 → 信号档位映射表"，覆盖脚本分析三档、shell 预检 deny、browser act、lark 写类；**裁决 browser act `dangerAssessment.dangerous` 映射为 `suspicious`**（保 P1 行为等价，顶层设计同步补注"browser 高危关键词属 ask 档"）；§8 P1 验收与 §9 回归补 browser act 专项对照；§2 现状盘点补 `:1367` 特判事实。
- 非阻断 1（豁免计数）：全文统一为"四类"（§1.1、§5.3、§8）。
- 非阻断 2（allowlist 消费位置）：定稿为"分类器吸收白名单"——名单内归 `direct-owner`、名单外归 `direct-other`，规则只按 origin kind 匹配；删除"白名单发送者映射为规则条目"的表述（§5.2a）。
- 非阻断 3（P1 体量）：exposure 规则化 + 渲染端 IPC 化拆为 P1 末尾独立可发布子阶段，失败可回退半步；风险表补对应行。
- 非阻断 4（预算三选不写缓存）：§5.5 伪代码与 §4 类型注释明写 `approved-with-action` / `timeout` 不进缓存写入。
- 非阻断 5（渲染端测试改造）：§9 补 `toolsConfigFilter.ts` 薄壳化后的测试改造条目。

### v1 → v2（对应评审 v1）

- **B1（P1/P3 衔接缺口）**：两期存储设计——P1 落 `LegacyExemptionAdapter`（签名规范化在此层），P3 换 `SqliteDecisionCache`，`DecisionCacheView` 接口不变；变体绕过测试集双落点；P1 验收新增豁免逐项等价。
- **B2（grant 非布尔语义）**：`remote-write` 移出缓存迁移清单，按读写拆分保留 `remoteWriteGrantRegistry` 本体。
- **B3（ingress 缺口）**：新增 `decideIngress` 纯函数入口与 IM 入站 handler 接线；P2 验收补 allowlist 逐项等价回归。
- **B4（自动审批器缺 lane 边界）**：自动审批规则固定 `lane:['desktop']`；按链路开放 auto 排除出本期。
- 非阻断 1–5：`ConfirmOutcome` 补 `approved-with-action`；Decision 补 `memoryTiers`；exposure 定稿"主进程唯一评估 + IPC 推送"；会话级条目补清理路径；纯函数层测试禁止 mock 环境。
