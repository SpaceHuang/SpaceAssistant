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
    id: 'wiki-raw-write-deny',
    when: 'invocation',
    match: { toolName: ['write_file', 'edit_file'], signals: ['wiki-raw-target'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: 'raw/ 为只读源，不可通过工具修改 (WIKI_RAW_READONLY)'
  },
  {
    id: 'remote-outside-write-deny',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: ['write_file', 'edit_file'], signals: ['write-target-scope:outside-workdir'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '远程会话只能写入当前工作目录内的文件'
  },
  {
    id: 'write-outside-standard-review', when: 'invocation',
    match: { lane: ['desktop'], toolName: ['write_file', 'edit_file'], signals: ['write-target-scope:outside-workdir', 'policy-tier:standard'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '工作目录外写入由安全审核 Agent 审核'
  },
  {
    id: 'write-outside-strict-human', when: 'invocation',
    match: { lane: ['desktop'], toolName: ['write_file', 'edit_file'], signals: ['write-target-scope:outside-workdir', 'policy-tier:strict'] },
    denyClass: 'insufficient-info', action: 'ask', humanRequired: true, reason: '严格档工作目录外写入需真人逐次确认'
  },
  {
    id: 'write-outside-loose-review', when: 'invocation',
    match: { lane: ['desktop'], toolName: ['write_file', 'edit_file'], signals: ['write-target-scope:outside-workdir', 'policy-tier:loose'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '宽松档工作目录外写入由安全审核 Agent 审核'
  },
  {
    id: 'outbound-mode-loose-allow', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['policy-tier:loose'], excludeSignals: ['outbound-evidence-present', 'outbound-inspection-incomplete'] },
    action: 'allow', reason: '宽松档普通出站按策略放行'
  },
  {
    id: 'outbound-mode-standard-review', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['policy-tier:standard'], excludeSignals: ['outbound-evidence-present', 'outbound-inspection-incomplete'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '标准档普通出站交由安全审核 Agent'
  },
  {
    id: 'outbound-mode-strict-human', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['policy-tier:strict'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'user', reason: '严格档出站动作需真人逐次确认'
  },
  {
    id: 'outbound-sensitive-standard-human', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-evidence-present', 'policy-tier:standard'] },
    denyClass: 'insufficient-info', action: 'ask', humanRequired: true, reason: '标准档敏感出站内容需真人逐次确认'
  },
  {
    id: 'outbound-sensitive-strict-human', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-evidence-present', 'policy-tier:strict'] },
    denyClass: 'insufficient-info', action: 'ask', humanRequired: true, reason: '严格档敏感出站内容需真人逐次确认'
  },
  {
    id: 'outbound-sensitive-loose-review', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-evidence-present', 'policy-tier:loose'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '宽松档敏感出站内容由安全审核 Agent 审核'
  },
  {
    id: 'outbound-incomplete-strict-human', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-inspection-incomplete', 'policy-tier:strict'] },
    denyClass: 'insufficient-info', action: 'ask', humanRequired: true, reason: '严格档出站事实检查不完整需真人确认'
  },
  {
    id: 'outbound-incomplete-review', when: 'invocation',
    match: { lane: ['desktop'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-inspection-incomplete'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '出站事实检查不完整，进入审核'
  },
  {
    id: 'outbound-incomplete-standard-review', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-inspection-incomplete', 'policy-tier:standard'], excludeSignals: ['outbound-evidence-present'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '标准档出站检查不完整，交由安全审核 Agent'
  },
  {
    id: 'outbound-incomplete-loose-review', when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: ['send_email', 'send_message', 'wechat_send', 'wechat_reply', 'run_lark_cli'], actionClass: 'outbound', signals: ['outbound-inspection-incomplete', 'policy-tier:loose'] },
    denyClass: 'insufficient-info', action: 'ask', answerer: 'agent', reason: '宽松档出站检查不完整，交由安全审核 Agent'
  },
  {
    id: 'remote-write-scope-unknown-deny',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: ['write_file', 'edit_file'], signals: ['write-target-scope:unknown'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '远程会话只能写入当前工作目录内的文件'
  },
  {
    id: 'remote-outside-read-deny',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu', 'automation'], toolName: ['read_file', 'grep', 'list_directory'], actionClass: 'read', signals: ['path-target:outside-workdir'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '非桌面会话只能读取当前工作目录内的普通路径'
  },
  {
    id: 'remote-wechat-media-outside-deny',
    when: 'invocation',
    match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'], signals: ['wechat-media-target:outside-workdir'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '微信附件只能来自当前工作目录内的文件'
  },
  {
    id: 'remote-wechat-media-unknown-deny',
    when: 'invocation',
    match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'], signals: ['wechat-media-target:unknown'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无法确认微信附件位于当前工作目录内，已阻止发送'
  },
  {
    id: 'write-target-unsupported-deny',
    when: 'invocation', match: { toolName: ['write_file', 'edit_file'], signals: ['write-target-unsupported'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '写入目标不是普通文件或新文件路径'
  },
  {
    id: 'feishu-media-boundary-deny',
    when: 'invocation',
    match: { lane: ['feishu', 'automation'], toolName: 'read_feishu_attachment', signals: ['feishu-media-target:outside'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '附件目标必须位于飞书媒体目录内'
  },
  {
    id: 'feishu-media-boundary-unknown-deny',
    when: 'invocation',
    match: { lane: ['feishu', 'automation'], toolName: 'read_feishu_attachment', signals: ['feishu-media-target:unknown'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无法确认附件目标边界，已阻止读取'
  },
  {
    id: 'remote-sensitive-workdir-switch-deny',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'switch_work_dir', signals: ['workdir-profile-target:sensitive'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '远程会话不得切换到敏感工作目录'
  },
  {
    id: 'remote-unknown-workdir-switch-deny',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'switch_work_dir', signals: ['workdir-profile-target:unknown'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无法确认目标工作目录是否敏感，已阻止切换'
  },
  {
    id: 'script-network-deny-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-network'] },
    denyClass: 'forbidden',
    action: 'deny',
    locked: true,
    reason: '远程链路禁止执行含网络访问的脚本'
  },
  {
    id: 'script-dangerous-deny',
    when: 'invocation',
    match: { toolName: 'run_script', signals: ['dangerous'] },
    denyClass: 'forbidden',
    action: 'deny',
    reason: '脚本事实包含明确危险行为'
  },
  // 远程出站硬禁（等价现 evaluateRemoteToolBlock：remoteDenyOutbound 时禁止飞书写类 lark 子命令 /
  // 微信主动出站）。定序先于预算暂停条目（现 :878 远程阻断先于 :929 预算门控）。
  {
    id: 'remote-deny-lark-write-outbound',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-write'] },
    denyClass: 'forbidden',
    action: 'deny',
    locked: true,
    configRequires: { config: 'remoteDenyOutbound', equals: true },
    reason: '远程策略禁止此类写操作。'
  },
  {
    id: 'remote-deny-wechat-outbound',
    when: 'invocation',
    match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'] },
    denyClass: 'forbidden',
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
    denyClass: 'forbidden',
    action: 'deny',
    locked: true,
    configRequires: { config: 'allowRemoteSessions', equals: false },
    reason: BROWSER_REMOTE_DISABLED_CODE
  },
  {
    id: 'remote-shell-disabled',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_shell' },
    denyClass: 'forbidden',
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
    denyClass: 'insufficient-info',
    action: 'deny',
    locked: true,
    requiresContext: { outboundWriteBudgetExhausted: true },
    reason: 'remote_task_budget'
  },
  {
    id: 'remote-outbound-budget-pause-lark',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-write'] },
    denyClass: 'insufficient-info',
    action: 'deny',
    locked: true,
    requiresContext: { outboundWriteBudgetExhausted: true },
    reason: 'remote_task_budget'
  },
  {
    id: 'shell-sensitive-path-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_shell', signals: ['path-target:sensitive-file'] },
    action: 'confirm-every-time', locked: true,
    reason: '命令涉及敏感位置，需真人确认'
  },
  {
    id: 'shell-system-dir-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_shell', signals: ['path-target:system-dir'] },
    action: 'confirm-every-time', locked: true,
    reason: '命令涉及系统目录，需真人确认'
  },
  {
    id: 'automation-script-path-unknown-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_script', signals: ['script-path-extraction:unknown'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无人值守调用无法确认脚本访问路径'
  },
  {
    id: 'automation-script-permission-missing-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_script', signals: ['automation-script-permission:missing'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '定时任务未获得覆盖脚本工作目录和访问路径的 run_script 授权'
  },
  {
    id: 'automation-unverified-script-language-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_script', signals: ['script-language-analysis:unverified'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无人值守调用不得执行未经完整内容分析的脚本语言'
  },
  {
    id: 'automation-sensitive-path-deny',
    when: 'invocation', match: { lane: ['automation'], signals: ['path-target:sensitive-file'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无人值守调用不得访问敏感位置'
  },
  {
    id: 'automation-system-dir-deny',
    when: 'invocation', match: { lane: ['automation'], signals: ['path-target:system-dir'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无人值守调用不得访问系统目录'
  },
  {
    id: 'automation-write-deny',
    when: 'invocation', match: { lane: ['automation'], toolName: ['write_file', 'edit_file'], excludeSignals: ['automation-output-binding:matched'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '无人值守调用不得写入未绑定的本地文件'
  },
  {
    id: 'automation-shell-deny',
    when: 'invocation', match: { lane: ['automation'], toolName: 'run_shell', signals: ['automation-shell-permission:missing'] },
    denyClass: 'forbidden',
    action: 'deny', locked: true, reason: '任务没有授予本地 Shell 命令权限'
  },
  {
    id: 'script-sensitive-path-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['path-target:sensitive-file'] },
    action: 'confirm-every-time', locked: true, reason: '脚本涉及敏感位置，需真人确认'
  },
  {
    id: 'script-system-dir-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['path-target:system-dir'] },
    action: 'confirm-every-time', locked: true, reason: '脚本涉及系统目录，需真人确认'
  },
  {
    id: 'script-path-unknown-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-dynamic-access'] },
    action: 'confirm-every-time', locked: true, reason: '脚本路径提取不完整，需真人确认'
  },
  {
    id: 'script-path-unclassified-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-path-extraction:unclassified'] },
    action: 'confirm-every-time', locked: true, reason: '脚本分析原因未分类，需真人确认'
  },
  {
    id: 'script-dynamic-execution-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-path-extraction:dynamic-execution'] },
    action: 'confirm-every-time', locked: true, reason: '脚本存在动态执行，需逐次真人确认'
  },
  {
    id: 'script-suspicious-path-unknown-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-analysis:suspicious', 'script-path-extraction:unmodeled-call'] },
    action: 'confirm-every-time', locked: true, reason: '可疑脚本不允许记忆放行'
  },
  {
    id: 'script-declared-path-scope-allow-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'run_script', signals: ['clean', 'script-path-extraction:unknown', 'script-path-declaration-consistent'] },
    action: 'allow',
    configRequires: { config: 'allowDeclaredPathScopeScripts', equals: true },
    reason: '脚本声明仅读工作目录且与分析交叉一致（设置开启后免确认）'
  },
  {
    id: 'script-unmodeled-path-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-path-extraction:unmodeled-call'] },
    action: 'ask', denyClass: 'insufficient-info', cacheableAsk: true, reason: '脚本含未建模调用；可选择仅在本会话信任相同脚本'
  },
  {
    id: 'script-unverified-language-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'run_script', signals: ['script-language-analysis:unverified'] },
    action: 'confirm-every-time', locked: true, reason: '该脚本语言尚未接入完整内容安全分析，需真人确认'
  },

  // ===== 第 4 步段：auto-evaluator（自动审批器入口）=====
  // 命中即「自动」动作：确定性快通道批准才返回；未裁决交审批 Agent（引擎第 4 步，answerer=agent）。
  // P1 起 desktop 通用「自动」由档位变换承载（standard 非 locked ask→auto-evaluator，§2.1 LANE_PROFILES），
  // 原 desktop-auto-approve 规则（confirmMode 门控）随之删除。
  // run_shell 预检放行（等价现 canSkipShellConfirm：结构化信任 argv 前缀匹配 / permissionDecision=allow）。
  // 评估器由执行链路注入（预检结果闭包）。信任命令的 exact 档同时经缓存命中
  // （迁移/记N 写入的 decision_cache 条目），两路语义一致（缓存键仅在无风险提示时派生）。
  // 评审 B2：auto-evaluator 必须带 lane 限定——automation 的 run_shell 即使命中预检信任命令也落 confirm。
  {
    id: 'shell-precheck-auto-allow',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'run_shell' },
    action: 'auto-evaluator',
    reason: 'shell 预检判定可跳过确认（信任命令或安全命令）'
  },

  // ===== 第 6 步段：默认表（ask / allow）=====
  {
    id: 'path-sensitive-read-confirm',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], actionClass: 'read', signals: ['path-target:sensitive-file'] },
    action: 'confirm-every-time',
    locked: true,
    reason: '读取敏感位置需真人确认'
  },
  {
    id: 'path-system-dir-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], actionClass: 'read', signals: ['path-target:system-dir'] },
    action: 'confirm-every-time',
    locked: true,
    reason: '读取系统目录需真人确认'
  },
  // 桌面显式文件读取的普通目标由生效规则统一裁决；不得在 gate 中绕过套餐/custom 规则直接 allow。
  {
    id: 'read-target-workdir-allow',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: ['read_file', 'grep', 'list_directory'], actionClass: 'read', signals: ['path-target:workdir-normal'] },
    action: 'allow',
    reason: '工作目录内普通只读访问免确认'
  },
  {
    id: 'path-outside-readonly-allow',
    when: 'invocation',
    match: { lane: ['desktop'], actionClass: 'read', signals: ['path-target:outside-workdir'] },
    action: 'allow',
    reason: '工作目录外的只读访问免确认'
  },
  // 脚本网络命中（脚本专属信号 + toolName 双重限定，避免卷进 browser / run_shell 的通用 network-egress）
  {
    id: 'script-network-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'run_script', signals: ['script-network'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: '桌面执行含网络访问的脚本需确认'
  },
  // 远程 clean 但未认证脚本降级为确认（script-uncertified 信号在未认证时产出）；fail-closed 兜底，locked
  {
    id: 'script-uncertified-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['script-uncertified'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    reason: '未通过远程安全认证的脚本需确认'
  },
  // 远程 clean 已认证脚本：消费 remoteScriptRequiresConfirm 配置（迁移门控语义）
  {
    id: 'script-clean-certified-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['clean'] },
    denyClass: 'insufficient-info',
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
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: '浏览器高危操作需确认'
  },
  {
    id: 'im-browser-act-danger-human',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-act-dangerous'] },
    denyClass: 'insufficient-info',
    action: 'ask', locked: true, humanRequired: true,
    reason: 'IM 浏览器高危操作需真人逐次确认'
  },
  // act 确认总开关关闭 → 免确认（等价现 browserActionNeedsConfirmation: !actRequiresConfirm → false，
  // 桌面/远程同一开关；configRequires 门控不满足即不命中，可先于 ask 条目）。
  // 评审 B2：allow 动作必须带 lane 限定——automation 无人类应答者，不消费该放行。
  {
    id: 'browser-act-allow-unconfigured',
    when: 'invocation',
    match: { lane: ['desktop', 'wechat', 'feishu'], toolName: 'browser', signals: ['browser-act'] },
    action: 'allow',
    configRequires: { config: 'actRequiresConfirm', equals: false },
    reason: '浏览器 act 确认开关已关闭'
  },
  // 远程 act：按迁移门控 + remoteBrowserActRequiresConfirm 开关决定（等价现
  // shouldSkipRemoteBrowserActConfirm；远程同时消费桌面 actRequiresConfirm，见上方 allow 条目）。
  {
    id: 'browser-act-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-act'], excludeSignals: ['browser-act-dangerous'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    configRequires: { config: 'actRequiresConfirm', equals: true },
    askUnless: { config: 'remoteActSkipConfirm', equals: true },
    reason: '远程浏览器 act 默认需确认'
  },
  {
    id: 'im-browser-act-review',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-act-low-risk'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    configRequires: { config: 'actRequiresConfirm', equals: true },
    askUnless: { config: 'remoteActSkipConfirm', equals: true },
    reason: '低影响浏览器读取/导航动作进入 standard 审核候选'
  },
  {
    id: 'browser-act-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'browser', signals: ['browser-act'], excludeSignals: ['browser-act-dangerous'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    configRequires: { config: 'actRequiresConfirm', equals: true },
    cacheableAsk: true,
    reason: '浏览器 act 需确认'
  },
  // navigate（open 模式）：远程仅在桌面与远程开关都要求时确认（等价现基线+跳过覆写叠加语义）；
  // 桌面按 navigateRequiresConfirm。信任域名经缓存命中放行（步骤 2，先于本段）。
  {
    id: 'browser-navigate-ask-remote',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-navigate-open'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    configRequires: [
      { config: 'navigateRequiresConfirm', equals: true },
      { config: 'remoteNavigateRequiresConfirm', equals: true }
    ],
    cacheableAsk: true,
    reason: '远程浏览器打开网页需确认'
  },
  {
    id: 'browser-navigate-ask-desktop',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'browser', signals: ['browser-navigate-open'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    askUnless: { config: 'navigateRequiresConfirm', equals: false },
    cacheableAsk: true,
    reason: '浏览器打开网页需确认'
  },
  // lark-cli 高影响/未知子命令无条件确认（fail-closed，等价现 larkCliWriteNeedsConfirm：
  // high_impact/unknown 不消费开关）；写类按开关；读类免确认。
  // 三条 fail-closed 兜底规则标 locked：任何套餐不得调松、不可覆盖（评审中等项）。
  {
    id: 'lark-message-group-human',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-message-target:group-or-multiple'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    humanRequired: true,
    reason: '飞书消息发送到群或多人，需真人逐次确认'
  },
  {
    id: 'lark-message-target-unknown-human',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-message-target:unknown'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    humanRequired: true,
    reason: '无法验证飞书消息接收对象，需真人逐次确认'
  },
  {
    id: 'lark-high-impact-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-high_impact'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    reason: 'lark-cli 高影响子命令需确认'
  },
  {
    id: 'lark-unknown-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-unknown'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    reason: 'lark-cli 子命令无法分类，信息不足需确认'
  },
  {
    id: 'lark-write-ask',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-write'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    askUnless: { config: 'larkCliWriteRequiresConfirm', equals: false },
    reason: 'lark-cli 写类子命令需确认'
  },
  {
    id: 'im-lark-low-write-review',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-standard-low-write'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    askUnless: { config: 'larkCliWriteRequiresConfirm', equals: false },
    reason: '已分类的普通飞书文档或个人日历写入进入 standard 审核候选'
  },
  {
    id: 'im-lark-message-self-review',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-message-target:self'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    askUnless: { config: 'larkCliWriteRequiresConfirm', equals: false },
    reason: '发送给已验证的本人账号，进入 standard 审核候选'
  },
  {
    id: 'im-lark-message-direct-review',
    when: 'invocation',
    match: { lane: ['feishu'], toolName: 'run_lark_cli', signals: ['lark-message-target:direct-other'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    askUnless: { config: 'larkCliWriteRequiresConfirm', equals: false },
    reason: '发送给一位已明确的个人接收者，进入 standard 审核候选'
  },
  {
    id: 'lark-read-allow',
    when: 'invocation',
    match: { lane: ['desktop', 'feishu'], toolName: 'run_lark_cli', signals: ['lark-read'] },
    action: 'allow',
    reason: 'lark-cli 读类子命令免确认'
  },
  // toolkit 能力集合（docs/requirement/agent-toolkit-capability-gateway-requirement.md §6 确认矩阵）：
  // 描述符 risk=read 的能力（env.*、action.session.status/list/read）免确认；
  // risk=act 的能力（action.mcp.add 等）需确认。按能力定制的策略用 `toolkit-capability:${id}` token。
  // toolkit 初期 desktop-only（lane 隔离），远程 lane 无此工具面。
  {
    id: 'toolkit-read-allow',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'toolkit.call', signals: ['toolkit-read'] },
    action: 'allow',
    reason: '能力集合只读能力免确认'
  },
  {
    id: 'im-time-query-review',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'toolkit.call', signals: ['toolkit-capability:env.time'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: 'IM 报时调用属于 standard 审核候选'
  },
  {
    id: 'toolkit-act-ask',
    when: 'invocation',
    match: { lane: ['desktop'], toolName: 'toolkit.call', signals: ['toolkit-act'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    reason: '能力集合变更类能力需确认'
  },
  // MCP 只读注解放行：工具带安全注解（readOnlyHint:true 且 destructiveHint≠true）时额外产
  // mcp-readonly 信号，命中本条目默认放行（替代原 per-server readonly-auto 豁免，改由策略可见、
  // 可审计、可覆盖）。必须排在 mcp-tool-ask 之前：注解安全调用同时带 mcp-tool 信号，先命中放行，
  // 否则落到 ask。strict 套餐按"非 locked allow 上调为 ask"自动收紧；custom 套餐可覆盖为 ask/deny
  // （「全局始终确认」由规则覆盖表达）。
  // B5：annotations 是 server 单方面声明的不可信输入，放行仅限桌面 lane——远程链路（wechat/feishu）
  // 不消费该豁免，只读工具一样可能把本地数据带回 IM 会话，落 mcp-tool-ask 确认。
  {
    id: 'mcp-account-unauthorized-deny',
    when: 'invocation',
    match: { signals: ['mcp-account-unauthorized'] },
    denyClass: 'forbidden',
    action: 'deny',
    locked: true,
    reason: 'MCP account is not authorized for the requested data scope'
  },
  {
    id: 'automation-mcp-permission-missing-deny',
    when: 'invocation',
    match: { lane: ['automation'], signals: ['automation-mcp-permission:missing'] },
    denyClass: 'forbidden',
    action: 'deny',
    locked: true,
    reason: '定时任务未获得当前 MCP 服务和工具版本的用户授权'
  },
  {
    id: 'mcp-readonly-allow',
    when: 'invocation',
    match: { lane: ['desktop'], signals: ['mcp-readonly'] },
    action: 'allow',
    reason: 'MCP 只读注解工具默认免确认'
  },
  {
    id: 'im-mcp-public-read-review',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], signals: ['mcp-public-read'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: '经宿主验证的公开只读 MCP 调用进入审核 Agent 候选'
  },
  // MCP 工具默认确认（总是产 mcp-tool 信号）；会话信任经缓存命中放行（步骤 2）。
  {
    id: 'mcp-tool-ask',
    when: 'invocation',
    match: { signals: ['mcp-tool'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: 'MCP 工具调用需确认'
  },
  {
    id: 'im-low-risk-create',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'write_file', signals: ['write-target-new'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: '普通工作区新建文件属于 IM standard 审核候选'
  },
  {
    id: 'im-low-risk-edit',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'edit_file', signals: ['write-target-existing', 'write-target-scope:inside-workdir', 'path-target:workdir-normal'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    reason: '普通工作区内既有文件编辑属于 IM standard 审核候选'
  },
  // 高危路径具有人审底线，独立于 IM standard 的兜底自动审核，且在任何缓存/审核器之前执行。
  {
    id: 'im-write-sensitive-path-confirm',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], actionClass: 'write', signals: ['path-target:sensitive-file'] },
    action: 'confirm-every-time', locked: true, humanRequired: true,
    reason: 'IM 写入敏感位置需真人逐次确认'
  },
  {
    id: 'im-write-ask',
    when: 'invocation',
    match: { lane: ['wechat', 'feishu'], actionClass: 'write', excludeSignals: [
      'write-target-new', 'write-target-existing',
      // Classified Feishu CLI writes have their own rule family (including the
      // legacy larkCliWriteRequiresConfirm gate); keep them out of the unknown-write fallback.
      'lark-standard-low-write', 'lark-message-target:self', 'lark-message-target:direct-other'
    ] },
    denyClass: 'insufficient-info',
    action: 'ask', cacheableAsk: true,
    reason: '未被低风险分类或人工确认底线覆盖的 IM 写入，交由标准档审核 Agent 评估'
  },

  // ===== automation lane（偏差 21/22：无人值守链路的显式规则集，§P2-4）=====
  // 无人类应答者：规则显式写出，兜底 fail-closed；automation 不继承任何 desktop 专属豁免。
  // Policy phase: only a host-produced match between the current result-write receipt and this run's archive can reach this write allow.
  {
    id: 'automation-bound-output-write-allow',
    when: 'invocation',
    match: { lane: ['automation'], toolName: ['write_file', 'edit_file'], signals: ['automation-output-binding:matched'] },
    action: 'allow',
    reason: '无人值守写入仅限用户授权的本次运行结果输出目录'
  },
  {
    id: 'automation-grep-permission-missing-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'grep', signals: ['automation-grep-permission:missing'] },
    action: 'deny', locked: true, denyClass: 'forbidden',
    reason: '定时任务未获得覆盖本次搜索路径的 grep 授权'
  },
  {
    id: 'automation-readonly-allow',
    when: 'invocation',
    match: {
      lane: ['automation'],
      toolName: [
        'read_file',
        'list_directory',
        'grep',
        'list_work_dirs',
        'history.read',
        'skills.read',
        'read_feishu_attachment'
      ]
    },
    action: 'allow',
    reason: 'automation 只读工具无外部副作用，免确认'
  },
  // R5（O9 · 用户决策 2026-09-25）：无人值守链路不接受审批 Agent 放行解析器无法分析的命令。
  // 事实链断裂（unsupported）+ 无人值守 → fail-closed。必须排在 automation-default-confirm 之前
  // （引擎按规则数组顺序匹配，catch-all 会拦截并把回答者派生为审批 Agent、approve 即放行）。
  {
    id: 'automation-unsupported-deny',
    when: 'invocation',
    match: { lane: ['automation'], signals: ['shell-unsupported-structure'] },
    action: 'deny',
    locked: true,
    denyClass: 'forbidden',
    reason: '该命令使用了当前解析器不支持的结构，且当前为无人值守链路：无法分析即不可执行'
  },
  {
    id: 'automation-shell-analysis-incomplete-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_shell', signals: ['shell-analysis-completeness:partial'] },
    action: 'deny', locked: true, denyClass: 'forbidden',
    reason: '无人值守 Shell 命令无法完整分析，已拒绝执行'
  },
  {
    id: 'automation-shell-path-facts-incomplete-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_shell', signals: ['extraction-failed'] },
    action: 'deny', locked: true, denyClass: 'forbidden',
    reason: '无人值守 Shell 命令的路径事实不完整，已拒绝执行'
  },
  {
    id: 'automation-shell-outside-root-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_shell', signals: ['path-target:outside-workdir'] },
    action: 'deny', locked: true, denyClass: 'forbidden',
    reason: '无人值守 Shell 命令触及任务授权目录之外的路径'
  },
  {
    id: 'automation-shell-outside-risk-deny',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_shell', signals: ['path-outside-heuristic'] },
    action: 'deny', locked: true, denyClass: 'forbidden',
    reason: '无人值守 Shell 命令可能访问授权目录之外的位置，已拒绝执行'
  },
  {
    id: 'automation-authorized-shell-allow',
    when: 'invocation',
    match: { lane: ['automation'], toolName: 'run_shell', signals: ['automation-shell-permission:matched'] },
    action: 'allow',
    reason: '本地 Shell 命令由此任务的用户访问授权明确批准'
  },
  // 默认兜底（catch-all）：新工具天然 fail-safe——落 confirm；automation 无人类应答者，
  // 回答者派生为审批 Agent（askAnswererFor('automation')==='agent'，approve 可放行）。locked：无豁免来源。
  // 【注释修正（B16）】旧注释「RejectingChannel 使其实际效果为拒绝」为回答者派生前（P3 收缩前）的
  // 过时表述，是评审 N1 误判的误导源——现状 catch-all 会真实咨询审批 Agent，并非天然拒绝。
  {
    id: 'automation-default-confirm',
    when: 'invocation',
    match: { lane: ['automation'] },
    denyClass: 'insufficient-info',
    action: 'ask',
    locked: true,
    reason: 'automation 无人类应答者，未显式放行的调用一律确认（实际拒绝）'
  },

  // ===== exposure 时机示例 =====
  {
    id: 'im-no-wechat-send',
    when: 'exposure',
    match: { lane: ['wechat', 'feishu'], toolName: 'wechat_send' },
    denyClass: 'forbidden',
    action: 'deny',
    locked: true,
    reason: '远程会话不允许主动发微信'
  },

  // ===== ingress 时机示例 =====
  {
    id: 'ingress-direct-other-deny',
    when: 'ingress',
    match: { lane: ['wechat', 'feishu'], origin: 'direct-other' },
    denyClass: 'forbidden',
    action: 'deny',
    reason: '发送者不在白名单，拒绝响应'
  },
  {
    id: 'ingress-feishu-group-deny',
    when: 'ingress',
    match: { lane: ['feishu'], origin: 'group' },
    denyClass: 'forbidden',
    action: 'deny',
    reason: '飞书群聊消息默认不响应'
  }
]
