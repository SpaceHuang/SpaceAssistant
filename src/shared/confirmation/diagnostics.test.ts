import { describe, expect, it } from 'vitest'

import {
  buildSafetyDiagnostics,
  denyClassMessageKey,
  type DenyClass,
} from './diagnostics'

const workspace = {
  profileId: 'profile-a',
  rootPath: 'C:\\work\\project',
  key: 'c:/work/project',
  source: 'session-binding' as const,
  sensitive: false,
  revision: 3,
}

describe('denyClassMessageKey（三类拒绝文案键互不相同）', () => {
  it('三类 denyClass 键可分', () => {
    expect(denyClassMessageKey('forbidden')).toBe('deny.forbidden.rule')
    expect(denyClassMessageKey('insufficient-info')).toBe('deny.insufficientInfo.rule')
    expect(denyClassMessageKey('out-of-bounds')).toBe('deny.outOfBounds.workdir')
    const keys = new Set((['forbidden', 'insufficient-info', 'out-of-bounds'] as DenyClass[]).map(denyClassMessageKey))
    expect(keys.size).toBe(3)
  })
})

describe('buildSafetyDiagnostics', () => {
  it('规则拒绝：denyClass 取规则声明，cause=rules-violated，basis 来自快照', () => {
    const d = buildSafetyDiagnostics({
      ruleId: 'im-no-wechat-send',
      ruleSource: 'builtin',
      ruleDenyClass: 'forbidden',
      workspace,
    })
    expect(d.denyClass).toBe('forbidden')
    expect(d.cause).toBe('rules-violated')
    expect(d.basis).toEqual({
      kind: 'workdir',
      workDir: workspace.rootPath,
      profileId: workspace.profileId,
      revision: 3,
      source: 'session-binding',
    })
    expect(d.messageKey).toBe('deny.forbidden.rule')
    expect(d.messageParams.ruleId).toBe('im-no-wechat-send')
    expect(d.suggestions.length).toBeGreaterThan(0)
  })

  it('路径事实 zone=outside-workdir 时 denyClass 覆盖为 out-of-bounds，且文案必须写出基准目录', () => {
    const d = buildSafetyDiagnostics({
      ruleId: 'default-write-deny',
      ruleSource: 'builtin',
      ruleDenyClass: 'forbidden',
      workspace,
      targets: [{ raw: '../etc/passwd', resolved: 'C:\\etc\\passwd', zone: 'outside-workdir' }],
    })
    expect(d.denyClass).toBe('out-of-bounds')
    expect(d.messageKey).toBe('deny.outOfBounds.workdir')
    expect(d.messageParams.basisWorkDir).toBe(workspace.rootPath)
    expect(d.messageParams.targetResolved).toBe('C:\\etc\\passwd')
    expect(d.targets).toHaveLength(1)
  })

  it('ask 类规则缺 denyClass 声明时兜底 insufficient-info（ask 本质 = 需补授权/信息）', () => {
    const d = buildSafetyDiagnostics({ ruleId: 'mcp-tool-ask', ruleSource: 'builtin', workspace })
    expect(d.denyClass).toBe('insufficient-info')
  })

  it('无快照时 basis 用 workDir 字符串兜底（profileId 空、revision 0）', () => {
    const d = buildSafetyDiagnostics({ ruleId: 'r', ruleSource: 'user-override', workDir: '/tmp/wd' })
    expect(d.basis).toEqual({ kind: 'workdir', workDir: '/tmp/wd', profileId: '', revision: 0, source: 'active-fallback' })
    expect(d.ruleSource).toBe('user-override')
  })

  it('denyClass=forbidden 的建议不得引导绕行（无 use-trusted-route/provide-path）', () => {
    const d = buildSafetyDiagnostics({ ruleId: 'r', ruleSource: 'builtin', ruleDenyClass: 'forbidden', workspace })
    expect(d.suggestions.some((s) => s.action === 'use-trusted-route' || s.action === 'provide-path')).toBe(false)
  })

  it('out-of-bounds 的建议含 ask-user（受信通道）与 provide-path（改基准内路径）', () => {
    const d = buildSafetyDiagnostics({
      ruleId: 'r',
      ruleSource: 'builtin',
      ruleDenyClass: 'forbidden',
      workspace,
      targets: [{ raw: 'x', resolved: 'C:\\outside', zone: 'outside-workdir' }],
    })
    expect(d.suggestions.some((s) => s.action === 'ask-user')).toBe(true)
  })
})
