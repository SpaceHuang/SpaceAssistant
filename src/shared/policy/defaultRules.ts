import type { PolicyRule } from '../confirmation/types'
import { BROWSER_REMOTE_DISABLED_CODE } from '../browserRemotePolicy'
import { SHELL_REMOTE_DISABLED_ERROR } from '../shellToolDisplay'

/**
 * 内置默认策略规则（数据，非代码）。
 *
 * 排序规范（约定 4）：数组按策略步骤分段——
 *  - 第 1 步段：`locked && action === 'deny'` 条目（硬拒绝）；
 *  - 第 4 步段：`action === 'auto-evaluator'` 条目（自动审批器入口）；
 *  - 第 6 步段：其余 `ask / allow` 条目（默认表），段内再按约定 3 排序（安全规则先于放行规则，
 *    带 requiresContext / configRequires 门控的条件放行可先于同域 ask 条目）。
 *
 * 其中的六条脚本规则（连同其顺序）为规范条目，是 P1 等价验收的裁决依据，不得自由调整。
 * 其余条目为示例（语义等价于现状，只是从代码变成数据）。
 */
export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  // ===== 第 1 步段：locked && deny（硬拒绝，先于任何缓存查询）=====
  {
    id: 'script-network-deny-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-network'] },
    action: 'deny',
    locked: true,
    reason: '远程链路禁止执行含网络访问的脚本'
  },
  // 远程出站硬禁（等价现 evaluateRemoteToolBlock：remoteDenyOutbound 时禁止飞书写类 lark 子命令 /
  // 微信主动出站）。定序先于预算暂停条目（现 :878 远程阻断先于 :929 预算门控）。
  {
    id: 'remote-deny-lark-write-outbound',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-write'] },
    action: 'deny',
    locked: true,
    configRequires: { config: 'remoteDenyOutbound', equals: true },
    reason: '远程策略禁止此类写操作。'
  },
  {
    id: 'remote-deny-wechat-outbound',
    when: 'invocation',
    match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'] },
    action: 'deny',
    locked: true,
    configRequires: { config: 'remoteDenyOutbound', equals: true },
    reason: '远程策略禁止此类写操作。'
  },
  // 远程链路硬约束：浏览器未开放远程会话 / run_shell 远程禁用（等价现 BROWSER_REMOTE_DISABLED_CODE /
  // SHELL_REMOTE_DISABLED_ERROR 内联阻断）。
  {
    id: 'remote-browser-disabled',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser' },
    action: 'deny',
    locked: true,
    configRequires: { config: 'allowRemoteSessions', equals: false },
    reason: BROWSER_REMOTE_DISABLED_CODE
  },
  {
    id: 'remote-shell-disabled',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_shell' },
    action: 'deny',
    locked: true,
    reason: SHELL_REMOTE_DISABLED_ERROR
  },
  // 出站写预算耗尽（读 ExecutionContext.outboundWriteBudgetRemaining；recordOutboundWrite 记账留执行链路）。
  // 该 deny 由主循环按 ruleId 映射为预算三选暂停（推送提示 + 中断本轮循环），IM 侧交互路径零变化。
  {
    id: 'remote-outbound-budget-pause-wechat',
    when: 'invocation',
    match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'] },
    action: 'deny',
    locked: true,
    requiresContext: { outboundWriteBudgetExhausted: true },
    reason: 'remote_task_budget'
  },
  {
    id: 'remote-outbound-budget-pause-lark',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-write'] },
    action: 'deny',
    locked: true,
    requiresContext: { outboundWriteBudgetExhausted: true },
    reason: 'remote_task_budget'
  },

  // ===== 第 4 步段：auto-evaluator（自动审批器入口）=====
  // 命中不产生 Decision，评估器裁决通过才返回；不裁决交还规则链后续条目（约定 2 例外）。
  // match 收窄到现状等价域：仅桌面 + 仅 write_file/edit_file + confirmMode=auto 配置前置。
  {
    id: 'desktop-auto-approve',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: ['write_file', 'edit_file'] },
    action: 'auto-evaluator',
    configRequires: { config: 'confirmMode', equals: 'auto' },
    reason: '桌面 confirmMode=auto 时写/编辑文件的自动审批'
  },
  // run_shell 预检放行（等价现 canSkipShellConfirm：结构化信任 argv 前缀匹配 / permissionDecision=allow）。
  // 评估器由执行链路注入（预检结果闭包）；不裁决则交还规则链。信任命令的 exact 档同时经缓存命中
  // （迁移/记N 写入的 decision_cache 条目），两路语义一致（缓存键仅在无风险提示时派生）。
  {
    id: 'shell-precheck-auto-allow',
    when: 'invocation',
    match: { toolName: 'run_shell' },
    action: 'auto-evaluator',
    reason: 'shell 预检判定可跳过确认（信任命令或安全命令）'
  },

  // ===== 第 6 步段：默认表（ask / allow）=====
  // 脚本网络命中（脚本专属信号 + toolName 双重限定，避免卷进 browser / run_shell 的通用 network-egress）
  {
    id: 'script-network-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'run_script', signals: ['script-network'] },
    action: 'ask',
    reason: '桌面执行含网络访问的脚本需确认'
  },
  // 远程 clean 但未认证脚本降级为确认（script-uncertified 信号在未认证时产出）；fail-closed 兜底，locked
  {
    id: 'script-uncertified-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-uncertified'] },
    action: 'ask',
    locked: true,
    reason: '未通过远程安全认证的脚本需确认'
  },
  // 远程 clean 已认证脚本：消费 remoteScriptRequiresConfirm 配置（迁移门控语义）
  {
    id: 'script-clean-certified-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['clean'] },
    action: 'ask',
    askUnless: { config: 'remoteScriptRequiresConfirm', equals: false, andMigrationComplete: true },
    reason: '远程 clean 已认证脚本按 remoteScriptRequiresConfirm 配置决定是否确认（默认确认）'
  },
  // 桌面 clean 脚本免确认
  {
    id: 'script-clean-allow-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'run_script', signals: ['clean'] },
    action: 'allow',
    reason: '桌面 clean 脚本按现状免确认直接执行'
  },
  // ===== 规范条目结束 =====

  // 浏览器 act 高危（dangerAssessment.dangerous → suspicious 档，§5.1 裁决：问而非拒）。
  // 定序先于 act 放行/询问条目；高危 act 的域名事实由执行链路剥离（不进缓存），此处兜底。
  {
    id: 'browser-act-danger-ask',
    when: 'invocation',
    match: { toolName: 'browser', signals: ['browser-act-dangerous'] },
    action: 'ask',
    reason: '浏览器高危操作需确认'
  },
  // act 确认总开关关闭 → 免确认（等价现 browserActionNeedsConfirmation: !actRequiresConfirm → false，
  // 桌面/远程同一开关；configRequires 门控不满足即不命中，可先于 ask 条目）。
  {
    id: 'browser-act-allow-unconfigured',
    when: 'invocation',
    match: { toolName: 'browser', signals: ['browser-act'] },
    action: 'allow',
    configRequires: { config: 'actRequiresConfirm', equals: false },
    reason: '浏览器 act 确认开关已关闭'
  },
  // 远程 act：按迁移门控 + remoteBrowserActRequiresConfirm 开关决定（等价现
  // shouldSkipRemoteBrowserActConfirm；远程同时消费桌面 actRequiresConfirm，见上方 allow 条目）。
  {
    id: 'browser-act-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-act'] },
    action: 'ask',
    askUnless: { config: 'remoteActSkipConfirm', equals: true },
    reason: '远程浏览器 act 默认需确认'
  },
  {
    id: 'browser-act-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'browser', signals: ['browser-act'] },
    action: 'ask',
    reason: '浏览器 act 需确认'
  },
  // navigate（open 模式）：远程仅在桌面与远程开关都要求时确认（等价现基线+跳过覆写叠加语义）；
  // 桌面按 navigateRequiresConfirm。信任域名经缓存命中放行（步骤 2，先于本段）。
  {
    id: 'browser-navigate-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-navigate-open'] },
    action: 'ask',
    configRequires: [
      { config: 'navigateRequiresConfirm', equals: true },
      { config: 'remoteNavigateRequiresConfirm', equals: true }
    ],
    reason: '远程浏览器打开网页需确认'
  },
  {
    id: 'browser-navigate-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'browser', signals: ['browser-navigate-open'] },
    action: 'ask',
    askUnless: { config: 'navigateRequiresConfirm', equals: false },
    reason: '浏览器打开网页需确认'
  },
  // lark-cli 高影响/未知子命令无条件确认（fail-closed，等价现 larkCliWriteNeedsConfirm：
  // high_impact/unknown 不消费开关）；写类按开关；读类免确认。
  // 三条 fail-closed 兜底规则标 locked：任何套餐不得调松、不可覆盖（评审中等项）。
  {
    id: 'lark-high-impact-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-high_impact'] },
    action: 'ask',
    locked: true,
    reason: 'lark-cli 高影响子命令需确认'
  },
  {
    id: 'lark-unknown-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-unknown'] },
    action: 'ask',
    locked: true,
    reason: 'lark-cli 子命令无法分类，信息不足需确认'
  },
  {
    id: 'lark-write-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-write'] },
    action: 'ask',
    askUnless: { config: 'larkCliWriteRequiresConfirm', equals: false },
    reason: 'lark-cli 写类子命令需确认'
  },
  {
    id: 'lark-read-allow',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-read'] },
    action: 'allow',
    reason: 'lark-cli 读类子命令免确认'
  },
  // MCP 只读注解放行：工具带安全注解（readOnlyHint:true 且 destructiveHint≠true）时额外产
  // mcp-readonly 信号，命中本条目默认放行（替代原 per-server readonly-auto 豁免，改由策略可见、
  // 可审计、可覆盖）。必须排在 mcp-tool-ask 之前：注解安全调用同时带 mcp-tool 信号，先命中放行，
  // 否则落到 ask。strict 套餐按"非 locked allow 上调为 ask"自动收紧；custom 套餐可覆盖为 ask/deny
  // （「全局始终确认」由规则覆盖表达）。
  // B5：annotations 是 server 单方面声明的不可信输入，放行仅限桌面 lane——远程链路（wechat/feishu）
  // 不消费该豁免，只读工具一样可能把本地数据带回 IM 会话，落 mcp-tool-ask 确认。
  {
    id: 'mcp-readonly-allow',
    when: 'invocation',
    match: { lane: ['desktop'], signals: ['mcp-readonly'] },
    action: 'allow',
    reason: 'MCP 只读注解工具默认免确认'
  },
  // MCP 工具默认确认（总是产 mcp-tool 信号）；会话信任经缓存命中放行（步骤 2）。
  {
    id: 'mcp-tool-ask',
    when: 'invocation',
    match: { signals: ['mcp-tool'] },
    action: 'ask',
    reason: 'MCP 工具调用需确认'
  },
  {
    id: 'im-write-ask',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], actionClass: 'write' },
    action: 'ask',
    reason: '远程链路写本地文件默认需要确认'
  },

  // ===== exposure 时机示例 =====
  {
    id: 'im-no-wechat-send',
    when: 'exposure',
    match: { lane: ['wechat', 'feishu'], toolName: 'wechat_send' },
    action: 'deny',
    locked: true,
    reason: '远程会话不允许主动发微信'
  },

  // ===== ingress 时机示例 =====
  {
    id: 'ingress-direct-other-deny',
    when: 'ingress',
    match: { lane: ['wechat', 'feishu'], origin: 'direct-other' },
    action: 'deny',
    reason: '发送者不在白名单，拒绝响应'
  },
  {
    id: 'ingress-feishu-group-deny',
    when: 'ingress',
    match: { lane: ['feishu'], origin: 'group' },
    action: 'deny',
    reason: '飞书群聊消息默认不响应'
  }
]
