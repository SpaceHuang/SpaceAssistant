# 远程一对一私聊安全优化——开发与自动化测试计划

> 版本：v1.0
>
> 制定日期：2026年7月15日
>
> 需求基线：[remote-private-chat-security-optimization-requirement.md](../requirement/remote-private-chat-security-optimization-requirement.md) v1.6
>
> 适用范围：飞书、微信远程私聊，及其共享的工具确认、Shell 信任、浏览器策略、任务预算和审计能力
>
> 计划状态：待实施
>
> 发布约束：需求中的 P0 未全部关闭前仅允许内部灰度；P1 全量发布门禁未全部通过前不得全量发布

---

## 1. 计划目标

本计划不重复建设当前工作树中已经存在的 v1.5 主体能力，而是按 v1.6 的风险依赖完成安全收口：

1. 用一次性配对码替换飞书“绑定窗口内首条 p2p 直接绑定”。
2. 为存量用户提供不静默放宽、可原子取消的安全配置迁移。
3. 将 Shell 原始字符串前缀信任升级为结构化简单命令信任。
4. 保持 `run_script` A/B/R 分析门禁，并补独立开关、资源限制、停止和执行摘要。
5. 拆分远程 browser navigate/act 策略，并对 browser act、飞书写操作实施高影响分类和 fail closed。
6. 增加远程任务预算、用户可见活动、主动告警、审计脱敏/保留/导出/清理。
7. 建立从纯函数单测、路由/工具循环集成测试到升级与停止竞态测试的自动化发布门禁。

### 1.1 实施原则

- 先身份和迁移，后减确认：一次性配对与保守迁移未通过时，不开放新的免确认默认。
- 最严结果优先：硬拒绝高于风险确认，风险确认高于用户免确认开关，旧兼容字段不得反向放宽。
- 分类失败即确认：脚本解析失败、browser act 无法判断、lark argv 无法分类均按 ask；明确 deny 不进入确认桥。
- 配置提交原子化：安全摘要取消、关闭或异常退出时，不得出现半保存或版本号提前推进。
- 审计最小化：只记录 allowlist 字段和脱敏摘要，任何配对码、凭据、Cookie、完整命令/脚本/敏感路径不得落盘。
- 自动化测试就近放置，继续使用 Vitest；Electron 逻辑使用 node 环境，React UI 使用 jsdom + Testing Library。

---

## 2. 当前代码与测试基线

以下结论以 2026年7月15日工作树为准。实施前先运行第 8 节基线命令并保存结果，避免把既有失败误归因于本项目。

| 能力 | 当前实现/测试证据 | 计划判断 |
|------|-------------------|----------|
| 飞书 P2P、owner 和绑定生命周期 | `electron/feishu/feishuInboundParser.ts`、`feishuOwnerBind.ts`、`remoteCommandRouter.ts`；已有 parser/owner/router bind 测试 | P2P/owner 可复用；首条消息绑定必须替换 |
| 微信绑定发送者强制 | `electron/wechat/weChatCommandRouter.ts`、`weChatIpc.ts`；已有 router 测试 | 保持并补登录、解绑、旧配置回归 |
| 文件写/出站显式开关 | `src/shared/imTypes.ts`、`electron/toolChatLoop.ts` | 已有主体；需接入“迁移完成”门禁 |
| 脚本内容分析 | `electron/shell/scriptContentSecurity.ts` 及 `scriptContentSecurity*.test.ts` | A/B/R 主体保留；补开关、预算、停止、摘要 |
| IM 确认协议 | `electron/remote/imConfirmReply.ts`、两端 ConfirmManager、`remoteConfirmBridge.ts` | 协议保留；底层信任范围需结构化 |
| Shell 信任 | `electron/shell/shellCommandTrust.ts` | 当前仍以原始字符串前缀匹配，是 P0 缺口 |
| browser 远程覆盖 | `electron/toolChatLoop.ts`、`toolChatLoop.phase2RemoteConfirm.test.ts` | 当前组合开关同时覆盖 navigate/act，需拆分 |
| lark 写确认 | `electron/feishu/larkCliSecurity.ts`、`toolChatLoop.ts` | 当前只区分读写，需增加高影响 argv 分类 |
| 审计与活动 UI | `electron/remote/imAuditLogger.ts`、两端 AuditLogger、`RemoteAuditDrawer.tsx` | 已有查询/展示基础；缺统一活动语义、脱敏门禁、导出清理和主动告警 |
| 取消基础设施 | `chatCancelRegistry.ts`、`pendingRequestRegistry.ts`、`remoteProgressCoordinator.ts` | 可复用；需统一为远程任务级停止并覆盖进程树/队列 |

### 2.1 实施前保护动作

- 不修改需求文档中的当前未提交内容；实现 PR 仅引用已评审的 v1.6 基线。
- 先为当前行为补“安全护栏测试”：复杂 Shell 命令永不因 legacy trust 免确认、脚本 deny 不进入确认桥、未迁移配置不走宽松 fallback。
- 将当前宽松默认（组合 browser 开关为 false、lark 写确认 false）限制在测试/内部 feature flag；全量默认按本计划的门禁调整。

---

## 3. 目标结构与关键数据模型

### 3.1 策略判定顺序

所有远程工具统一按以下顺序判定，避免不同渠道产生分叉：

```text
身份/p2p 校验
  → 显式硬拒绝（本地写、出站、脚本 deny）
  → 内容或动作风险分类（deny / ask / allow）
  → 存量迁移安全覆盖（未完成时只可变严）
  → 工具独立确认开关
  → 结构化信任命中（仅简单 Shell 命令）
  → 任务预算检查
  → 执行、摘要与审计
```

建议把上述判定的可测试纯逻辑从 `toolChatLoop.ts` 抽到小模块，`toolChatLoop.ts` 只负责串联、确认桥和执行结果回传，避免继续扩大单文件分支。

### 3.2 配置模型

在 `RemoteImCommonConfig` 中增加或收敛：

```ts
interface RemoteImCommonConfig {
  remoteSecurityConfigVersion?: number
  remoteSecurityPresetSource?: 'new-install' | 'upgrade-recommended' | 'upgrade-safer' | 'custom'
  remoteScriptRequiresConfirm: boolean
  remoteBrowserNavigateRequiresConfirm: boolean
  remoteBrowserActRequiresConfirm: boolean
  /** @deprecated，仅用于保守迁移 */
  remoteBrowserRequiresConfirm?: boolean
  remoteTaskBudget: {
    maxToolCalls: number       // 50
    maxExecutionWallSec: number // 900
    maxConcurrentExecutions: number // 1
    maxConsecutiveOutboundWrites: number // 10
  }
}
```

配置读取分成两层：

- raw stored config：保留“字段是否缺失”的信息，用于判断存量和迁移状态。
- normalized runtime config：只有新安装已完成首次摘要，或存量已提交当前安全版本后，才可应用新装宽松默认。

禁止在通用 merge 阶段仅因字段缺失就写入 `remoteSecurityConfigVersion`。`remoteConfirmPolicy`、`remoteGroupTrigger`、`remoteCommandPrefix` 只兼容反序列化；前者仅允许迁移 `remote_read_only`，不得参与运行时确认决策。

### 3.3 结构化 Shell 信任

将 `TrustedShellCommand.command` 迁移为可版本化结构：

```ts
interface TrustedShellCommand {
  id: string
  schemaVersion: 2
  executable: string
  fixedArgvPrefix: string[]
  trailingArgv: 'plain-tokens' | 'exact'
  source: 'desktop' | 'feishu' | 'wechat'
  createdAt: number
  lastUsedAt?: number
  expired?: boolean
  legacyStatus?: 'converted-pending-review' | 'invalid'
}
```

解析器输出必须明确区分：

- 可持久信任的单个简单命令；
- 本次可执行但不可信任/不可命中信任的复杂命令；
- 无法可靠解析的命令。

`$()`、反引号、管道、重定向、逻辑连接符、分号、换行、多命令、前置环境变量赋值、变量或通配展开一律不能写入或命中持久信任。匹配按 argv token 边界，不得调用 `startsWith` 授权。

### 3.4 飞书配对状态

`FeishuOwnerBindSnapshot` 扩展展示态，但不暴露配对码摘要：

```ts
interface FeishuOwnerBindSnapshot {
  status: 'idle' | 'binding' | 'bound'
  bindingExpiresAt?: number
  failedAttempts?: number
  remainingAttempts?: number
  maskedOwnerOpenId?: string
  boundAt?: number
}
```

`startBindingWindow` 只在创建窗口时向桌面调用方返回一次明文展示码，renderer 仅在组件内存中显示；后续 status IPC 不再返回明文码，窗口丢失时必须重新发起。控制器只保存 `{ codeDigest, consumed, failedAttempts, expiresAt }`。码使用去混淆 Base32 8 字符、至少 40 bit 熵；比较使用恒定时间比较；消费与 owner 写入在同一同步临界区完成。绑定协议解析独立为纯函数，仅接受去首尾空白后的精确 `绑定 <code>` / `bind <code>`。

---

## 4. 开发工作包与合并顺序

每个工作包必须同时提交对应自动化测试。标记为“门禁”的工作包未通过时，后续工作可以开发但不能开放默认。

### WP0：冻结现状与安全护栏测试（P0，先行）

目标：在大规模重构前锁定最危险的负例。

开发内容：

- 为 `toolChatLoop` 增加可注入的统一策略判定接口，保持现有外部行为不变。
- 先强制所有含 Shell 元语法的命令不能命中 legacy trust，也不能显示“确认并信任”。
- 明确脚本 `deny` 直接生成工具错误结果，不创建 IM/桌面 pending confirm。
- 对 raw legacy 配置增加运行时保守覆盖：迁移完成前文件写、脚本 allow、browser act、飞书写继续 ask。

主要文件：

- `electron/toolChatLoop.ts`
- `electron/shell/shellCommandTrust.ts`
- `src/shared/imTypes.ts`
- `electron/toolChatLoop.phase2RemoteConfirm.test.ts`
- `electron/shell/shellCommandTrust.test.ts`
- 建议新增 `electron/remote/remoteToolPolicy.ts` 与同名测试

完成标准：AC7b、AC-Trust-Meta-Neg、AC15 的护栏先通过；无免确认默认扩大。

### WP1：飞书一次性配对与身份闭环（P0，发布门禁）

开发内容：

- 在 `feishuOwnerBind.ts` 中生成、校验、消费一次性配对码，限制 5 分钟/5 次失败。
- 新增精确配对协议解析；普通文本、错误/过期/复用码不进入 Agent。
- 并发消费使用单实例原子状态转换，最多一个 sender 成功；成功后立即失效。
- 超时、取消、尝试耗尽、清 owner 均设置 `remoteEnabled=false`；重绑先清旧 owner，旧 owner 立即失效。
- `remoteCommandRouter.ts` 只在 p2p 且处于绑定态时把消息交给绑定协议；绑定消息无论成功失败都被消费。
- IPC 返回桌面显示码、倒计时、剩余尝试、脱敏 owner 和绑定时间；成功同时通知桌面与对应私聊。
- 所有审计事件不记录明文码，owner 只记录脱敏值或 hash。
- 保持微信 allowlist 为空/不匹配时 fail closed，并覆盖扫码登录、解绑、session 失效和重绑。

主要文件：

- `electron/feishu/feishuOwnerBind.ts`
- `electron/feishu/remoteCommandRouter.ts`
- `electron/feishu/feishuIpc.ts`
- `electron/feishu/feishuInboundParser.ts`
- `src/shared/feishuTypes.ts`
- `src/renderer/components/Config/FeishuSettingsTab.tsx`
- `electron/wechat/weChatIpc.ts`
- `electron/wechat/weChatCommandRouter.ts`
- preload/API 类型声明中的 owner-bind IPC 定义

完成标准：AC1–AC4、全部 AC-Bind-*、AC-WeChat-Sender 通过。

### WP2：存量安全配置原子迁移与摘要 UI（P0，发布门禁）

开发内容：

- 新增 `remoteSecurityConfigVersion` 和当前 schema 常量；只在用户确认摘要后推进。
- 建立纯函数迁移规划器，输入 raw 飞书/微信配置和安装/启用状态，输出：是否需要摘要、旧有效安全强度、推荐/更安全初始值、legacy 映射和待写 patch。
- `remote_read_only` 始终先映射为 `remoteAllowLocalWrite=false` + `remoteDenyOutbound=true`，不受摘要取消影响。
- 组合 browser 旧字段保守迁移：旧 `true` → navigate/act 都为 true；旧 `false` 对存量不得静默令 act 免确认。
- 摘要覆盖文件写、脚本/Shell 副作用、navigate、act、飞书外部写，以及“一键限制并非真正只读”。
- 使用数据库事务一次提交飞书/微信公共安全字段、选择来源和版本；取消/关闭/异常不写任何摘要选择。若当前数据库封装不暴露事务，新增窄化的安全配置事务函数，不在 renderer 逐字段保存。
- 首次启用远程的新安装也必须先完成摘要；之后允许在 Remote IM 设置逐项修改。

建议新增文件：

- `src/shared/remoteSecurityMigration.ts`
- `electron/remote/remoteSecurityConfigDb.ts`
- `src/renderer/components/Config/RemoteSecurityUpgradeModal.tsx`
- 对应 `.test.ts` / `.test.tsx`

修改文件：

- `src/shared/imTypes.ts`、`feishuTypes.ts`、`wechatTypes.ts`
- `electron/feishu/feishuIpc.ts`、`electron/wechat/weChatIpc.ts`
- `src/renderer/store/configSlice.ts`
- `src/renderer/components/Config/RemoteImCommonSettings.tsx`

完成标准：AC5、AC12–AC15、AC-Policy-Migrate、全部 AC-Upgrade-* 通过。

### WP3：结构化 Shell 信任与双通道竞态（P0，发布门禁）

开发内容：

- 扩展 Shell tokenizer/parser，输出 executable、argv token、元语法标记和可否持久信任。
- 以结构化范围替换 `normalizeTrustedCommandPrefix`/字符串前缀授权；`npm test` 不匹配 `npm testing`。
- 规定尾部参数：默认只允许普通 argv token；无法解释参数边界时使用 exact argv。
- 信任记录增加来源、创建/最后使用时间、schemaVersion 和 legacy 状态。
- legacy 项可无歧义解析时标记“待用户确认转换”，否则失效；迁移摘要确认前不能用于免确认。
- IM 的 `Y trust` / `确认并信任` 和桌面卡片统一调用同一结构化写入函数；风险确认场景中的 trust 短语不批准、不写入。
- 任一通道成功后原子关闭同一 pending，另一通道后到的回复不可再次执行或写入。
- 设置页展示规范化范围、来源、时间、失效状态，支持单项撤销。

主要文件：

- `electron/shell/shellCommandParser.ts`
- `electron/shell/shellCommandTrust.ts`
- `electron/shell/shellConfigDb.ts`
- `src/shared/domainTypes.ts`
- `electron/remote/remoteConfirmBridge.ts`
- `electron/remote/imConfirmReply.ts`
- 两端 ConfirmManager
- `src/renderer/components/Config/ShellSettingsTab.tsx`
- `src/renderer/components/Chat/ShellConfirmCard.tsx`

完成标准：AC8、AC10、AC-Cold-Start、AC-Steady、全部 AC-Trust-* 通过。

### WP4：脚本独立策略、执行资源边界与停止（P0/P1）

开发内容：

- 保持 `analyzeScriptContent` 的 AST、折叠、别名和 B11 语义；`patterns` 继续返回 A/B 编号。
- 增加 `remoteScriptRequiresConfirm`：只把分析为 allow 的远程脚本提升为 ask；绝不覆盖 ask/deny。桌面行为保持需求矩阵。
- `autoAllowScriptExecution` 只保留兼容 UI/反序列化，不再绕过内容分析。
- 强制 `run_script` 使用 `buildShellEnv` 或等价过滤环境。
- 在执行资源层实现：默认超时、输出上限、单远程会话最多一个脚本/Shell、终止可归属进程树。
- 建立统一远程任务取消 token：桌面和 owner 私聊均可停止当前任务；桌面“紧急关闭远程”先取消执行、pending confirm 和排队任务，再停监听。
- 生成脚本执行摘要：耗时、退出状态、超时/截断/预算、可观察工作区修改和可用恢复入口。
- 所有用户文案只使用“未发现已知高风险模式”；deny 主文案不直接暴露 A/B 编号。

建议新增/修改文件：

- `electron/remote/remoteTaskController.ts`
- `electron/tools/toolExecutionResource.ts`
- `electron/tools/builtinExecutors.ts`
- `electron/toolChatLoop.ts`
- `electron/shell/scriptContentSecurity.ts`
- `electron/chatCancelRegistry.ts`
- 两端 command router/remote agent 的停止命令处理
- `src/renderer/components/Chat/ScriptConfirmCard.tsx`
- 执行摘要展示组件

完成标准：全部 AC-Script-*、AC25 通过；停止优先级和进程树终止有集成测试。

### WP5：远程任务预算与恢复（P1，全量发布门禁）

开发内容：

- 新增 request/session 级 `RemoteTaskBudget`，默认：工具 50 次、脚本/Shell 累计 900 秒、并行执行 1、连续外部写 10 次。
- 预算检查放在确认/执行前；达到阈值后暂停而不是丢消息，并返回“继续/回桌面/停止”。
- “继续”仅为当前任务增加一次同额额度，不修改持久配置；审批与任务 ID 绑定，不能跨任务复用。
- 连续外部写在第 11 次执行前 ask，批准后计数清零；硬拒绝仍优先于预算确认。
- 紧急停止清空队列并使继续 token 失效。

建议新增文件：

- `electron/remote/remoteTaskBudget.ts`
- `electron/remote/remoteTaskBudget.test.ts`
- `electron/remote/remoteTaskController.test.ts`

修改文件：`electron/toolChatLoop.ts`、两端 ConfirmManager/remote agent、远程进度协议类型。

完成标准：AC-Task-Budget、AC-Script-Budget、AC-Script-Stop 通过。

### WP6：browser navigate/act 分层（P1，全量发布门禁）

开发内容：

- 用 `remoteBrowserNavigateRequiresConfirm` 和 `remoteBrowserActRequiresConfirm` 替换运行时组合开关。
- screenshot/observe/extract 不确认；navigate 仅受远程 navigate 开关影响；桌面 `DEFAULT_BROWSER_CONFIG` 不变。
- 即使关闭远程 act 确认，提交、发送、购买/支付、删除、授权、账号/权限修改仍 ask。
- 扩展 `actDangerAssessor` 的后果类别和稳定规则；页面扫描/目标解析失败时，在远程免确认路径按高风险 ask，而不是返回 SAFE。
- 确认摘要统一输出风险、影响对象、是否可撤销、下一步。

主要文件：

- `src/shared/imTypes.ts`
- `electron/toolChatLoop.ts`
- `electron/browser/actDangerAssessor.ts`
- `electron/browser/browserActionPolicy.ts`
- `src/renderer/components/Config/RemoteImCommonSettings.tsx`
- `src/renderer/components/Chat/BrowserConfirmCard.tsx`

完成标准：AC-Browser-Scope、AC-Browser-HighRisk、NG8 回归通过。

### WP7：飞书外部写风险分类（P1，全量发布门禁）

开发内容：

- 在 `assertSafeLarkCliArgs` 完成 argv 解析后调用确定性分类器，不对完整命令做模糊关键词匹配。
- 最少分类：群/多人消息、批量或删除文档/记录、含他人的日历邀请、权限/共享范围变更均为 high-impact。
- 低影响写才可跟随 `larkCliWriteRequiresConfirm`；未知操作、缺参数、解析失败一律 ask。
- 分类稳定前把全量默认恢复为 `larkCliWriteRequiresConfirm=true`。
- 设置和确认摘要说明第三方影响对象及可撤销性。

建议新增文件：

- `electron/feishu/larkCliImpactPolicy.ts`
- `electron/feishu/larkCliImpactPolicy.test.ts`

修改文件：`electron/feishu/larkCliSecurity.ts`、`electron/toolChatLoop.ts`、`src/shared/feishuTypes.ts`、`FeishuSettingsTab.tsx`。

完成标准：AC22、AC-Lark-Classify、AC-Outbound-Deny 通过。

### WP8：近期活动、告警、隐私与清理（P1，全量发布门禁）

开发内容：

- 定义跨飞书/微信统一的远程安全事件 schema；渠道 logger 可继续分文件，UI 合并为按会话时间线。
- 覆盖绑定、非 owner/群拒绝、信任新增/撤销、脚本 ask/deny、免确认执行、外部写、预算暂停/继续和紧急停止。
- logger 入口采用字段 allowlist + 集中 sanitizer；拒绝未知字段直接写盘。
- 默认保留 30 天；支持更短配置、导出脱敏 JSON、清除远程活动。清理不删除 owner、安全配置或信任项。
- 绑定变化、信任新增、5 分钟内连续 3 次安全拒绝触发桌面告警；绑定/安全设置变更同步 owner 私聊；普通成功不主动推送。
- 活动记录支持进入会话、撤销信任、关闭远程；技术编号只在详情/导出显示。

建议新增/修改文件：

- `src/shared/remoteSecurityAudit.ts`
- `electron/remote/imAuditLogger.ts`
- 两端 AuditLogger 与 IPC
- `src/renderer/components/DetailPanel/RemoteAuditDrawer.tsx`
- 两端现有 AuditDrawer/Table
- 主动通知/浮动通知管理器

完成标准：全部 AC-Reject-Audit、AC-Activity、AC-Audit-Privacy、AC-Alert、AC-Confirm-Summary 通过。

### WP9：i18n、跨文档同步与发布控制

开发内容：

- 为配对、升级摘要、结构化信任、预算恢复、近期活动、拒绝原因和四项确认摘要补齐中英文 key。
- 更新 `feishu-integration-requirement.md`、`wechat-integration-requirement.md` 和 `confirmation-card-trust-requirement.md` 的冲突内容。
- 发布说明披露脚本分析是启发式闸门而非沙箱，并列出 R 类残余风险。
- 设置 feature flag/配置版本回滚路径；错误绑定、信任越权、deny 绕过或任务无法停止时可分别关闭免确认能力，必要时关闭远程总入口。

完成标准：AC-i18n、需求 §6.5 交付项和第 8 节全部发布门禁通过。

---

## 5. 自动化测试策略

### 5.1 测试层次

| 层次 | 目的 | 技术与隔离方式 |
|------|------|----------------|
| 纯函数单测 | 协议解析、迁移矩阵、Shell token、风险分类、预算状态机、审计 sanitizer | Vitest node；表驱动测试；不依赖 Electron/网络 |
| 模块单测 | owner 状态机、信任 DB、AuditLogger、执行资源、IPC handler | fake timers、内存数据库、临时目录、mock runner/process |
| 工具循环集成 | 验证 deny/ask/allow、确认桥、预算和执行顺序 | mock LLM/tool executor/renderer sender；断言 pending 和审计副作用 |
| 路由集成 | 飞书/微信身份、配对、并发、双通道确认与停止 | 构造 inbound 消息；mock IM outbound；不访问真实飞书/微信 |
| Renderer 组件测试 | 摘要原子保存、配对倒计时、信任列表、活动操作、i18n 文案 | jsdom + Testing Library；mock `window.api` |
| 打包前回归 | 类型、i18n、全量单测、构建 | npm scripts；CI 串行执行以匹配当前 Vitest 配置 |

真实 IM 账号、真实浏览器购买/删除、真实第三方写操作不进入 CI。它们仅使用测试租户做发布前 smoke，且不得产生生产外部影响。

### 5.2 测试设计规则

- 时间相关逻辑全部注入 `now`/timer，使用 fake timers，不等待真实 5 分钟或 30 天。
- 并发测试使用 Promise barrier 同时提交，不依赖随机调度；断言成功数严格为 1。
- 随机配对码测试断言字符集、长度、摘要存储和不泄漏，不断言固定随机值；生成器可注入 deterministic stub。
- 进程树终止使用受控子进程夹具和 fake process adapter；CI 不运行破坏性 Shell。
- 安全负例表驱动并固定编号；B1–B11 不得放入 residual/known-bypass fixture。
- 审计测试读取实际临时日志，扫描禁写字段和值（code/token/cookie/完整命令脚本路径）。
- 所有分类器至少覆盖：明确高风险、明确低风险、未知、缺字段、解析异常五类。
- 所有配置迁移测试同时断言“内存有效策略”和“实际持久化内容”，防止 merge 正确但落盘错误。

---

## 6. 自动化测试用例矩阵

### 6.1 身份与配对

建议文件：

- `electron/feishu/feishuOwnerBind.test.ts`
- `electron/feishu/remoteCommandRouter.bind.test.ts`
- `electron/feishu/feishuInboundParser.test.ts`
- `electron/wechat/weChatCommandRouter.test.ts`
- `electron/wechat/weChatIpc.test.ts`（新增）

| 场景 | 关键断言 | AC |
|------|----------|----|
| 生成配对码 | 8 字符去混淆 Base32、至少 40 bit；明文只随创建结果返回一次，后续 snapshot/audit/config 均不含码 | AC1、AC-Audit-Privacy |
| 精确中英文协议 | 仅 `绑定 <有效码>` / `bind <code>` 成功；多余文本、缺码、普通消息不绑定且不进 Agent | AC1 |
| p2p/群聊 | 群聊永远拒绝；legacy group 字段不生效 | AC3、AC13 |
| 错误/过期/复用 | 均不绑定；错误累计 5 次后关闭远程；普通文本不泄漏剩余状态 | AC-Bind-Code-Neg |
| 超时/取消/清 owner | `remoteEnabled=false`，timer 清理，审计事件准确 | AC-Bind-Timeout、Cancel |
| 重绑 | 清旧 owner 后旧消息立即拒绝；新码成功后新 owner 生效 | AC-Bind-Rebind |
| 并发抢跑 | 两个 sender 经 barrier 同时提交同一码，成功数=1；失败方不进 Agent | AC-Bind-Race |
| 双端通知 | 成功只通知一次；桌面含脱敏 owner/时间/撤销入口，IM 不泄露码 | AC-Bind-Notify |
| 配置损坏 | enabled=true 且无 owner、无活动窗口时，业务消息 fail closed | AC-Bind-Neg |
| 微信 sender | allowlist 空、非绑定人、session 过期均拒绝；扫码/重绑后的唯一用户可进入 | AC-WeChat-Sender |

### 6.2 配置与迁移

建议文件：

- `src/shared/remoteSecurityMigration.test.ts`
- `src/shared/imTypes.test.ts`
- `src/shared/wechatTypes.test.ts`
- `electron/remote/remoteSecurityConfigDb.test.ts`
- `src/renderer/components/Config/RemoteSecurityUpgradeModal.test.tsx`

表驱动覆盖：

| raw 场景 | 摘要前有效行为 | 保存后期望 |
|----------|----------------|------------|
| 新安装/从未启用 | 首次启用前阻止远程；展示摘要 | 依所选预设原子写入当前版本 |
| 缺全部新字段 | 文件、脚本 allow、act、lark 写保持确认 | 用户确认后才采用选择 |
| `remote_read_only` | 文件写和出站立即硬拒绝 | 两个显式开关为 false/true，legacy 字段仅兼容保留 |
| browser legacy=true | navigate/act 均确认 | 保守映射后可由用户修改 |
| browser legacy=false（存量） | act 仍确认；navigate 不比旧有效行为更宽 | 摘要明确选择后拆分 |
| 部分自定义字段 | 每项取不比旧行为更宽值 | 保留更严用户选择 |
| 推荐预设 | 摘要前不生效 | file/script allow 可免确认、navigate 免确认、act/high-impact lark 确认 |
| 更安全预设 | 摘要前不生效 | file/script/navigate/act/lark 写均确认 |
| 取消/关闭/保存异常 | 配置和版本均不变 | 重启仍提示摘要并保持旧强度 |

另用故障注入让事务在各写入点抛错，断言飞书、微信、版本和选择来源全部回滚。

### 6.3 Shell 信任

建议文件：

- `electron/shell/shellCommandParser.test.ts`
- `electron/shell/shellCommandTrust.test.ts`
- `electron/remote/remoteConfirmBridge.test.ts`
- 两端 ConfirmManager 测试
- `src/renderer/components/Config/ShellSettingsTab.test.tsx`

| 场景 | 期望 | AC |
|------|------|----|
| `npm test` exact/token 匹配 | 可匹配明确允许的普通尾参；不匹配 `npm testing` | AC-Trust-Token |
| 元语法矩阵 | `$()`、反引号、`>`/`>>`、管道、`&&`、`||`、`;`、换行、env 前缀、变量、glob 均不能新增或命中 trust | AC-Trust-Meta-Neg |
| risk ack | 不显示 trust；`Y trust` 不批准、不写入 | AC-Trust-Protocol |
| 普通协议 | `Y` 仅本次；`Y trust`/`确认并信任` 写入；单独“信任”和非法回复不消费 pending | AC-Trust-Protocol |
| 双通道竞态 | 桌面/IM 同时确认仅执行一次、写 trust 一次，另一 pending 关闭 | AC-Tests |
| legacy 可解析 | 仅进入待确认转换，确认前不授权 | AC-Trust-UX |
| legacy 不可解析 | 标记失效，要求重新信任 | AC-Trust-UX |
| 列表操作 | 来源/时间/范围可见，单项撤销后立刻失效 | AC10、AC-Trust-UX |
| 冷/热路径 | 无 trust 首次确认 1 次；已 trust 的简单命令稳定态可 0 次 | AC-Cold-Start、AC-Steady |

### 6.4 脚本安全与资源控制

保留现有三组脚本测试，并明确夹具目录/describe 名称：

- `scriptContentSecurity.test.ts`：A 清单及解析失败。
- `scriptContentSecurity.b.test.ts`：B1–B11，每项至少一条正例，`patterns` 含编号，verdict 非 allow。
- `scriptContentSecurity.residual.test.ts`：只放 R1–R4 范围；至少 R1 +（R2 或 R3）。

新增测试：

| 场景 | 期望 | AC |
|------|------|----|
| allow + 远程开关 false/true | 分别免确认/ask | AC6 |
| ask/deny 不被开关覆盖 | ask 进入确认；deny 不创建 pending | AC7、AC7b |
| 外联 remote/desktop | remote deny、desktop ask | AC7c |
| env 过滤 | API key、token、secret 等不进入执行环境 | AC25 |
| 输出超限 | 截断、有审计和摘要，主进程/IM 不阻塞 | AC-Script-Budget/Summary |
| 超时与进程树 | 父子进程均终止，任务暂停并显示原因 | AC-Script-Budget |
| 同会话并发 | 第二个脚本/Shell 排队，不并行启动 | AC-Task-Budget |
| IM/桌面停止 | 执行、排队、pending 全部取消；停止优先 | AC-Script-Stop |
| 紧急关闭远程 | 先取消任务再停监听，新的 inbound 被拒 | AC-Script-Stop |
| 用户文案 | 主文案无“安全脚本”和 A/B 编号；deny 有回桌面路径 | AC-Script-Copy |

### 6.5 browser 与 lark 风险分类

建议文件：

- `electron/toolChatLoop.phase2RemoteConfirm.test.ts`
- `electron/browser/actDangerAssessor.test.ts`
- `electron/browser/browserActionPolicy.test.ts`
- `electron/feishu/larkCliImpactPolicy.test.ts`

browser 用例：

- 新安装 navigate=false、act=true；存量走迁移覆盖；桌面两个全局默认仍为 true。
- observe/extract/screenshot 不受远程两开关影响。
- act 开关关闭时，普通无提交填写可免确认。
- 提交、发送、购买/支付、删除、授权、账号/权限修改始终 ask。
- 页面扫描失败、目标解析失败、未知动作、缺 instruction 均 ask。
- 确认摘要四项字段齐全，且技术分类只在详情中出现。

lark 用例：

- 群/多人消息、批量写、删除、邀请他人、权限/共享变更均 high-impact/ask。
- 单人低影响写正例在开关 false 时可免确认，在 true 时 ask。
- 读操作不确认；`remoteDenyOutbound=true` 的写操作在分类/确认前硬拒绝。
- 未知 argv、缺参数、解析异常 fail closed；测试断言分类基于 tokenized argv。

### 6.6 任务预算、审计与告警

建议文件：

- `electron/remote/remoteTaskBudget.test.ts`
- `electron/remote/imAuditLogger.test.ts`
- 两端 AuditLogger 测试
- `src/renderer/components/DetailPanel/RemoteAuditDrawer.test.tsx`

预算状态机测试：50 次工具调用边界、900 秒累计边界、并发 1、连续写 10/11 次、“继续”只加当前任务一次额度、停止后继续 token 失效。

审计与隐私测试：

- 每类要求事件可按 session/request 查询。
- 输入包含配对码、`sk-` key、Cookie、长命令、脚本、绝对敏感路径时，落盘和导出均不含原值。
- 30 天边界使用 fake clock；清理只删活动，不删 config/trust。
- 轮转文件同样执行保留与脱敏规则。
- 5 分钟内第 3 次安全拒绝恰好触发一次告警；窗口外重新计数；普通成功不告警。
- 活动 UI 可跳会话、撤销 trust、关闭远程；失败操作有可见反馈。

---

## 7. 验收标准到工作包映射

| 需求验收组 | 主工作包 | 自动化门禁 |
|------------|----------|------------|
| AC1–AC4、AC-Bind-*、AC-WeChat-Sender | WP1 | owner/router/IPC 集成全绿 |
| AC5–AC7c、AC12–AC15、AC-Upgrade-* | WP0、WP2、WP4 | 迁移矩阵 + tool loop 策略全绿 |
| AC8、AC10、AC-Trust-* | WP0、WP3 | parser/trust/双通道竞态全绿 |
| AC-Script-*、AC25 | WP4、WP5 | A/B/R、资源、停止、摘要全绿 |
| AC16–AC21 | WP0、WP3 | 放宽三项正例 + 危险规则负例全绿 |
| AC22、AC-Lark-Classify、AC-Outbound-Deny | WP7 | lark 分类表与 fail-closed 全绿 |
| AC-Browser-*、NG8 | WP2、WP6 | 远程/桌面策略矩阵全绿 |
| AC24、AC-Task-Budget | WP5 | 默认值和预算状态机全绿 |
| AC-Reject-Audit、AC-Activity、AC-Audit-Privacy、AC-Alert | WP8 | logger 实盘测试 + UI 测试全绿 |
| AC-i18n、AC-Confirm-Summary、AC-Tests | WP1–WP9 | i18n、全量测试和构建全绿 |

---

## 8. 执行命令与 CI 门禁

### 8.1 开发阶段快速反馈

按工作包运行就近测试，例如：

```bash
npx vitest run electron/feishu/feishuOwnerBind.test.ts electron/feishu/remoteCommandRouter.bind.test.ts
npx vitest run electron/shell/shellCommandParser.test.ts electron/shell/shellCommandTrust.test.ts
npx vitest run electron/shell/scriptContentSecurity.test.ts electron/shell/scriptContentSecurity.b.test.ts electron/shell/scriptContentSecurity.residual.test.ts
npx vitest run electron/toolChatLoop.phase2RemoteConfirm.test.ts
npx vitest run electron/remote/remoteTaskBudget.test.ts electron/remote/imAuditLogger.test.ts
npx vitest run src/renderer/components/Config/RemoteSecurityUpgradeModal.test.tsx src/renderer/components/DetailPanel/RemoteAuditDrawer.test.tsx
```

若计划中的新增测试文件尚未创建，先运行同工作包现有测试，再在实现 PR 中加入新文件。

### 8.2 PR 必跑

```bash
npm test
npm run i18n:check
npm run build:electron
npm run build:renderer
```

涉及设置/用户文案的 PR 额外运行：

```bash
npm run i18n:check:strict
```

### 8.3 安全发布门禁

以下任一失败即禁止进入对应发布阶段：

- 配对码并发成功数不是 1、绑定消息进入 Agent、未绑定业务消息未 fail closed。
- 存量摘要前出现任一能力静默放宽，或取消/异常产生部分保存。
- Shell 元语法命令命中信任，或 legacy trust 未确认即获得结构化授权。
- 脚本 B1–B11 任一 allow、B 夹具进入 residual、远程外联不是 deny。
- deny 创建确认 pending，或双通道导致重复执行/重复信任。
- browser/lark 未知分类不是 ask，或桌面 browser 默认被远程配置改写。
- 超时无法终止可归属进程树、紧急停止不能清除执行/排队/pending。
- 审计落盘包含配对码、凭据、Cookie、完整敏感命令/脚本/路径。

不以全局覆盖率百分比替代上述安全场景门禁。对新增的迁移、配对、结构化 trust、预算和风险分类纯函数，要求所有分支均有明确正例/负例；覆盖率报告用于发现遗漏，但发布结论以 AC 场景通过为准。

---

## 9. 分层发布、观测与回滚

| 阶段 | 开放范围 | 进入条件 | 回滚触发 |
|------|----------|----------|----------|
| 内部灰度 | owner/P2P、显式开关、脚本分析、基础审计 | WP0–WP2 完成；仅测试账号；停止入口可用 | 绑定错误、deny 绕过、迁移放宽 |
| 小流量 | 文件写免确认、navigate 免确认、结构化 Shell trust | WP3、WP4、WP6、活动恢复路径完成 | trust 越权、无法停止、活动缺失 |
| 全量 | 脚本 allow 新装免确认、低影响 browser/lark 免确认 | WP5–WP9 和全部适用 AC 完成 | 高影响分类漏判、预算失效、隐私泄漏 |

每阶段至少观察：绑定失败/抢跑、非 owner 拒绝、script ask/deny/allow、skip-confirm 原因、trust 新增/撤销、预算暂停、任务取消耗时、browser/lark 高影响 ask 率和审计写入失败率。不得上传完整用户内容作为遥测。

回滚要求：

- feature flag 可分别关闭脚本、navigate、act、lark 低影响免确认和结构化 trust 命中。
- 回滚到上一配置 schema 时，显式硬拒绝和用户“更安全”选择不得变宽。
- 若结构化 trust 读取失败，全部 trust 视为未命中并要求确认，不回退到字符串前缀。
- 若风险分类器异常，browser act/lark 写整体 ask；若配对状态异常，关闭远程。

---

## 10. 交付物与完成定义

实现完成必须同时具备：

- WP0–WP9 的代码、就近自动化测试和必要 IPC/API 类型更新。
- 需求 §5 全部适用 AC 的测试结果清单，明确哪些由单测、集成测试、UI 测试或测试租户 smoke 覆盖。
- `npm test`、`npm run i18n:check`、Electron/renderer build 全绿记录。
- 安全摘要、拒绝提示、确认摘要、活动页的中英文文案。
- 脚本 R 类残余风险、非真正只读边界和分层发布说明。
- 需求 §6.5 的跨文档同步。
- 灰度开关、紧急关闭远程和配置回滚演练记录。

只有在上述交付物齐全，且不存在错误绑定、信任越权、deny 绕过、任务无法停止或审计敏感信息泄漏时，才可把需求状态更新为“已验收”。
