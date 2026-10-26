import { describe, expect, it, vi } from 'vitest'
import { filterBuiltinToolsForApi, filterBuiltinToolsForApiWithApproval, requireAutomationShellWorkingDirectory } from './toolsConfigRuntime'
import { MACOS_BASH_PROFILE } from './shell/shellProfiles'
import { DEFAULT_SHELL_CONFIG, DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../src/shared/feishuTypes'

describe('toolsConfigRuntime shell profile snapshot', () => {
  it('桌面默认配置暴露 run_shell', () => {
    const tools = filterBuiltinToolsForApi(
      DEFAULT_TOOLS_CONFIG,
      undefined,
      undefined,
      undefined,
      DEFAULT_SHELL_CONFIG
    )

    expect(tools.some((tool) => tool.name === 'run_shell')).toBe(true)
  })

  it('uses the request snapshot to generate run_shell description', () => {
    const tools = filterBuiltinToolsForApi(
      { enabled: true, deniedTools: [], allowedTools: [] } as never,
      undefined,
      undefined,
      undefined,
      { enabled: true } as never,
      undefined,
      undefined,
      undefined,
      {
        profile: MACOS_BASH_PROFILE,
        os: 'darwin',
        cwd: '/tmp/project',
        pathSeparator: '/',
        supportsAnsi: true,
        supportsTty: false
      }
    )
    const shell = tools.find((tool) => tool.name === 'run_shell')
    expect(shell?.description).toContain('dialect=posix-bash')
    expect(shell?.description).toContain('/tmp/project')
    expect(shell?.input_schema).toEqual(expect.objectContaining({ required: ['command'] }))
  })

  it('requires the per-call working directory on the automation Shell schema', () => {
    const shell = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, undefined, undefined, undefined, DEFAULT_SHELL_CONFIG).find((tool) => tool.name === 'run_shell')!
    const [automationShell] = requireAutomationShellWorkingDirectory([shell])

    expect(automationShell?.input_schema).toMatchObject({
      properties: { workingDirectory: { type: 'string' } },
      required: ['command', 'workingDirectory']
    })
    expect(automationShell?.description).toContain('workingDirectory')
  })
})

describe('飞书附件工具暴露范围', () => {
  const feishu = { ...DEFAULT_FEISHU_CONFIG, enabled: true }

  it('当前请求没有登记附件时不暴露附件读取工具', () => {
    const tools = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, feishu, undefined, {
      source: 'feishu', messageId: 'm1', confirmPolicy: 'im_confirm', feishuAttachments: []
    })
    expect(tools.some((tool) => tool.name === 'read_feishu_attachment')).toBe(false)
  })

  it('只向模型公开当前请求登记的附件编号', () => {
    const tools = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, feishu, undefined, {
      source: 'feishu', messageId: 'm1', confirmPolicy: 'im_confirm',
      feishuAttachments: [{ id: 'attachment-1', messageId: 'm1', localPath: '/user/feishu-media/cache/m1/a.png', fileName: 'a.png' }]
    })
    const tool = tools.find((item) => item.name === 'read_feishu_attachment')
    expect(tool?.input_schema).toMatchObject({
      properties: { attachmentId: { type: 'string', enum: ['attachment-1'] } },
      required: ['attachmentId']
    })
    expect(JSON.stringify(tool?.input_schema)).not.toContain('/user/feishu-media')
  })
})

describe('按对象批准 exposure ask', () => {
  it('批准后只把明确的工具对象加入本次 IM 工具清单', async () => {
    const requestApproval = vi.fn(async ({ toolName }: { toolName: string }) => toolName === 'wechat_send')
    const tools = await filterBuiltinToolsForApiWithApproval({
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat', messageId: 'm-1', confirmPolicy: 'im_confirm' },
      rules: [{ id: 'im-no-wechat-send', when: 'exposure', match: { lane: ['wechat', 'feishu'], toolName: ['wechat_send', 'wechat_reply'] },
        action: 'ask', userOverride: true, reason: 'require approval' } as never],
      requestApproval
    })
    expect(requestApproval).toHaveBeenCalledWith({ lane: 'wechat', toolName: 'wechat_send', ruleId: 'im-no-wechat-send' }, expect.any(AbortSignal))
    expect(tools.map((tool) => tool.name)).toContain('wechat_send')
    expect(tools.map((tool) => tool.name)).not.toContain('wechat_reply')
  })

  it('拒绝或批准异常都保持目标工具未暴露', async () => {
    const args = {
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat' as const, messageId: 'm-2', confirmPolicy: 'im_confirm' as const },
      rules: [{ id: 'im-no-wechat-send', when: 'exposure' as const, match: { lane: ['wechat', 'feishu'], toolName: 'wechat_send' },
        action: 'ask' as const, userOverride: true, reason: 'require approval' } as never]
    }
    const rejected = await filterBuiltinToolsForApiWithApproval({ ...args, requestApproval: async () => false })
    expect(rejected.map((tool) => tool.name)).not.toContain('wechat_send')
    const unavailable = await filterBuiltinToolsForApiWithApproval({ ...args, requestApproval: async () => { throw new Error('dialog unavailable') } })
    expect(unavailable.map((tool) => tool.name)).not.toContain('wechat_send')
  })

  it('授权代次经历 A→B→A 后丢弃旧 exposure 批准并重新请求', async () => {
    const rules = [{ id: 'im-no-wechat-send', when: 'exposure' as const,
      match: { lane: ['wechat', 'feishu'], toolName: 'wechat_send' }, action: 'ask' as const,
      userOverride: true, reason: 'require approval' } as never]
    let version = 'im-v2:1:1'
    let approvals = 0
    const tools = await filterBuiltinToolsForApiWithApproval({
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat', messageId: 'm-aba', confirmPolicy: 'im_confirm' },
      rules, resolveRules: () => rules, resolveAuthorizationVersion: () => version,
      requestApproval: async () => {
        approvals += 1
        if (approvals === 1) version = 'im-v2:3:3'
        return approvals === 1
      }
    })
    expect(tools.map((tool) => tool.name)).not.toContain('wechat_send')
    expect(approvals).toBe(2)
  })

  it('新策略允许时不受旧 exposure prompt 的拒绝结果阻断', async () => {
    let rules = [{ id: 'im-no-wechat-send', when: 'exposure' as const,
      match: { lane: ['wechat', 'feishu'], toolName: 'wechat_send' }, action: 'ask' as const,
      userOverride: true, reason: 'require approval' } as never]
    const tools = await filterBuiltinToolsForApiWithApproval({
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat', messageId: 'stale-deny', confirmPolicy: 'im_confirm' },
      rules, resolveRules: () => rules,
      requestApproval: async () => {
        rules = [{ ...rules[0]!, action: 'allow' }]
        return false
      }
    })
    expect(tools.map((tool) => tool.name)).toContain('wechat_send')
  })

  it('策略变更通知会唤醒仍未返回的 exposure 审批并按新 allow 暴露工具', async () => {
    let rules = [{ id: 'im-no-wechat-send', when: 'exposure' as const, match: { lane: ['wechat'], toolName: 'wechat_send' },
      action: 'ask' as const, userOverride: true, reason: 'require approval' } as never]
    let wake = () => undefined
    const tools = filterBuiltinToolsForApiWithApproval({
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat', messageId: 'wake-pending-exposure', confirmPolicy: 'im_confirm' },
      rules, resolveRules: () => rules,
      subscribePolicyChanges: (listener) => { wake = listener; return () => undefined },
      requestApproval: () => new Promise<boolean>(() => undefined)
    })
    await Promise.resolve()
    rules = [{ ...rules[0]!, action: 'allow' }]
    wake()
    await expect(tools).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'wechat_send' })]))
  })

  it('订阅策略通知前后的版本间隙不会打开已过期的 exposure 审批窗', async () => {
    let rules = [{ id: 'im-no-wechat-send', when: 'exposure' as const, match: { lane: ['wechat'], toolName: 'wechat_send' },
      action: 'ask' as const, userOverride: true, reason: 'old ask' } as never]
    let version = 1
    const requestApproval = vi.fn(async () => true)
    const tools = await filterBuiltinToolsForApiWithApproval({
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat', messageId: 'subscribe-race-exposure', confirmPolicy: 'im_confirm' },
      rules, resolveRules: () => rules, resolveAuthorizationVersion: () => `version-${version}`,
      subscribePolicyChanges: () => {
        rules = [{ ...rules[0]!, action: 'allow' }]
        version += 1
        return () => undefined
      }, requestApproval
    })
    expect(tools.map((tool) => tool.name)).toContain('wechat_send')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('旧 exposure 审批未返回时策略仍为 ask 会立即请求新审批', async () => {
    let rules = [{ id: 'im-no-wechat-send', when: 'exposure' as const, match: { lane: ['wechat'], toolName: 'wechat_send' },
      action: 'ask' as const, userOverride: true, reason: 'old ask' } as never]
    let wake = () => undefined
    let approvals = 0
    const tools = filterBuiltinToolsForApiWithApproval({
      cfg: { enabled: true, deniedTools: [], allowedTools: [] } as never,
      wechat: { enabled: true } as never,
      remoteContext: { source: 'wechat', messageId: 'replace-pending-exposure', confirmPolicy: 'im_confirm' },
      rules, resolveRules: () => rules,
      subscribePolicyChanges: (listener) => { wake = listener; return () => undefined },
      requestApproval: () => {
        approvals += 1
        return approvals === 1 ? new Promise<boolean>(() => undefined) : Promise.resolve(true)
      }
    })
    await Promise.resolve()
    rules = [{ ...rules[0]!, reason: 'new ask' }]
    wake()
    await expect(tools).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'wechat_send' })]))
    expect(approvals).toBe(2)
  })
})
