import { describe, expect, it } from 'vitest'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
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
