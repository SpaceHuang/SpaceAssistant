import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_RULES } from './defaultRules'

/**
 * defaultRules 规则全集契约：规则增删需显式更新 ID 基线，并同步核对关键规则语义。
 * 2026-10-16：将已进入生产规则表的 13 条 IM/MCP 规则补入快照，避免快照长期落后于策略实现。
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
  'wiki-domain-file-bypass-deny',
  'wiki-schema-update-automation-deny',
  'wiki-schema-update-human-confirm',
  'wiki-page-restore-automation-deny',
  'wiki-page-write-automation-deny',
  'wiki-page-restore-human-confirm',
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
  'automation-grep-permission-missing-deny',
  'automation-script-permission-missing-deny',
  'automation-shell-analysis-incomplete-deny',
  'automation-shell-path-facts-incomplete-deny',
  'automation-shell-outside-root-deny',
  'automation-shell-outside-risk-deny',
  'automation-authorized-shell-allow',
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
  'automation-mcp-permission-missing-deny',
  'mcp-tool-ask',
  'im-write-ask',
  'automation-bound-output-write-allow',
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
  'ingress-direct-other-deny',
  'ingress-feishu-group-deny',
  'lark-message-group-human',
  'lark-message-target-unknown-human'
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

    expect(byId.get('wiki-domain-file-bypass-deny')).toMatchObject({ locked: true, action: 'deny', match: { signals: ['wiki-managed-target', 'wiki-domain-enabled'] } })

    expect(byId.get('wiki-schema-update-automation-deny')).toMatchObject({ locked: true, action: 'deny', match: { lane: ['automation'], toolName: 'memory.wiki_update_schema' } })
    expect(byId.get('wiki-schema-update-human-confirm')).toMatchObject({ locked: true, action: 'ask', answerer: 'user', humanRequired: true, match: { toolName: 'memory.wiki_update_schema' } })
    expect(byId.get('wiki-page-restore-automation-deny')).toMatchObject({ locked: true, action: 'deny', match: { lane: ['automation'], toolName: 'memory.wiki_apply_restore' } })
    expect(byId.get('wiki-page-write-automation-deny')).toMatchObject({ locked: true, action: 'deny', match: { lane: ['automation'], toolName: ['memory.wiki_save_page', 'memory.wiki_move_page'] } })
    expect(byId.get('wiki-page-restore-human-confirm')).toMatchObject({ locked: true, action: 'ask', answerer: 'user', humanRequired: true, match: { toolName: 'memory.wiki_apply_restore' } })

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
