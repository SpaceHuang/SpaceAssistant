import type { PolicyRule } from '../confirmation/types'

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

  // ===== 第 6 步段：默认表（ask / allow）=====
  // 脚本网络命中（脚本专属信号 + toolName 双重限定，避免卷进 browser / run_shell 的通用 network-egress）
  {
    id: 'script-network-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'run_script', signals: ['script-network'] },
    action: 'ask',
    reason: '桌面执行含网络访问的脚本需确认'
  },
  // 远程 clean 但未认证脚本降级为确认（script-uncertified 信号在未认证时产出）
  {
    id: 'script-uncertified-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-uncertified'] },
    action: 'ask',
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
  // grant 消费规则：远程写授权有效且余量充足 → 免确认（定序先于 im-write-ask）
  {
    id: 'remote-write-grant-allow',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], actionClass: 'write' },
    action: 'allow',
    requiresContext: { remoteWriteGrantValid: true },
    reason: '远程写授权 grant 有效且余量充足时免确认'
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
    match: { origin: 'direct-other' },
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
