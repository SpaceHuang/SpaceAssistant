import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_RULES } from './defaultRules'

/**
 * T1.5：defaultRules 零改动契约（wiki-shared-centralized-storage D5/§9.1）。
 * 挂载改造只修正探测层信号，策略规则本体（id/action/locked/match）必须零改动。
 * 本测试以显式快照锁定规则全集——任何规则变更都会转红，需显式更新快照并说明理由。
 */
const EXPECTED_RULE_IDS = [
  'write-outside-standard-review',
  'write-outside-strict-human',
  'write-outside-loose-review',
  'outbound-mode-loose-allow',
  'outbound-mode-standard-review',
  'outbound-mode-strict-human',
  'outbound-sensitive-standard-human',
  'outbound-sensitive-strict-human',
  'outbound-sensitive-loose-review',
  'outbound-incomplete-strict-human',
  'outbound-incomplete-review',
  'outbound-incomplete-standard-review',
  'outbound-incomplete-loose-review',
  'wiki-raw-write-deny',
  'remote-outside-write-deny',
  'remote-write-scope-unknown-deny',
  'remote-outside-read-deny',
  'remote-wechat-media-outside-deny',
  'remote-wechat-media-unknown-deny',
  'write-target-unsupported-deny',
  'feishu-media-boundary-deny',
  'feishu-media-boundary-unknown-deny',
  'remote-sensitive-workdir-switch-deny',
  'remote-unknown-workdir-switch-deny',
  'script-network-deny-remote',
  'script-dangerous-deny',
  'remote-deny-lark-write-outbound',
  'remote-deny-wechat-outbound',
  'remote-browser-disabled',
  'remote-shell-disabled',
  'remote-outbound-budget-pause-wechat',
  'remote-outbound-budget-pause-lark',
  'shell-sensitive-path-confirm',
  'shell-system-dir-confirm',
  'automation-script-path-unknown-deny',
  'automation-unverified-script-language-deny',
  'automation-sensitive-path-deny',
  'automation-system-dir-deny',
  'automation-write-deny',
  'automation-shell-deny',
  'script-sensitive-path-confirm',
  'script-system-dir-confirm',
  'script-path-unknown-confirm',
  'script-path-unclassified-confirm',
  'script-dynamic-execution-confirm',
  'script-suspicious-path-unknown-confirm',
  'script-declared-path-scope-allow-desktop',
  'script-unmodeled-path-ask',
  'script-unverified-language-confirm',
  'shell-precheck-auto-allow',
  'path-sensitive-read-confirm',
  'path-system-dir-ask',
  'read-target-workdir-allow',
  'path-outside-readonly-allow',
  'script-network-ask-desktop',
  'script-uncertified-ask-remote',
  'script-clean-certified-remote',
  'script-clean-allow-desktop',
  'browser-act-danger-ask',
  'browser-act-allow-unconfigured',
  'browser-act-ask-remote',
  'browser-act-ask-desktop',
  'browser-navigate-ask-remote',
  'browser-navigate-ask-desktop',
  'lark-high-impact-ask',
  'lark-unknown-ask',
  'lark-write-ask',
  'lark-read-allow',
  'toolkit-read-allow',
  'toolkit-act-ask',
  'mcp-readonly-allow',
  'mcp-tool-ask',
  'im-write-ask',
  'automation-readonly-allow',
  'automation-unsupported-deny',
  'automation-default-confirm',
  'im-no-wechat-send',
  'im-browser-act-danger-human',
  'im-browser-act-review',
  'im-lark-low-write-review',
  'im-lark-message-direct-review',
  'im-lark-message-self-review',
  'im-low-risk-create',
  'im-low-risk-edit',
  'im-mcp-public-read-review',
  'im-time-query-review',
  'im-write-sensitive-path-confirm',
  'lark-message-group-human',
  'lark-message-target-unknown-human',
  'mcp-account-unauthorized-deny',
  'ingress-direct-other-deny',
  'ingress-feishu-group-deny'
]

describe('DEFAULT_POLICY_RULES 零改动契约（T1.5）', () => {
  it('规则全集快照：id 集合、locked、action 与基线一致', () => {
    expect(DEFAULT_POLICY_RULES.map((rule) => rule.id).sort()).toEqual([...EXPECTED_RULE_IDS].sort())
    expect(DEFAULT_POLICY_RULES).toHaveLength(EXPECTED_RULE_IDS.length)

    for (const rule of DEFAULT_POLICY_RULES) {
      expect(rule.match && typeof rule.match).toBe('object')
      expect(typeof rule.action).toBe('string')
    }
  })

  it('wiki/远程/automation/敏感读 六条关键 locked 规则的 action 与匹配信号保持基线', () => {
    const byId = new Map(DEFAULT_POLICY_RULES.map((rule) => [rule.id, rule]))

    const wikiRaw = byId.get('wiki-raw-write-deny')!
    expect(wikiRaw.locked).toBe(true)
    expect(wikiRaw.action).toBe('deny')
    expect(JSON.stringify(wikiRaw.match)).toContain('wiki-raw-target')
    expect(JSON.stringify(wikiRaw.match)).toContain('write_file')

    const remoteWrite = byId.get('remote-outside-write-deny')!
    expect(remoteWrite.locked).toBe(true)
    expect(remoteWrite.action).toBe('deny')
    expect(JSON.stringify(remoteWrite.match)).toContain('write-target-scope:outside-workdir')

    const remoteRead = byId.get('remote-outside-read-deny')!
    expect(remoteRead.locked).toBe(true)
    expect(remoteRead.action).toBe('deny')
    expect(JSON.stringify(remoteRead.match)).toContain('path-target:outside-workdir')
    expect(JSON.stringify(remoteRead.match)).toContain('automation')

    const automationSensitive = byId.get('automation-sensitive-path-deny')!
    expect(automationSensitive.locked).toBe(true)
    expect(automationSensitive.action).toBe('deny')
    expect(JSON.stringify(automationSensitive.match)).toContain('sensitive-file')

    const pathSensitiveConfirm = byId.get('path-sensitive-read-confirm')!
    expect(pathSensitiveConfirm.locked).toBe(true)
    expect(pathSensitiveConfirm.action).toBe('confirm-every-time')
    expect(JSON.stringify(pathSensitiveConfirm.match)).toContain('sensitive-file')

    const wechatMedia = byId.get('remote-wechat-media-outside-deny')!
    expect(wechatMedia.locked).toBe(true)
    expect(wechatMedia.action).toBe('deny')
    expect(JSON.stringify(wechatMedia.match)).toContain('wechat-media-target:outside-workdir')
  })
})
