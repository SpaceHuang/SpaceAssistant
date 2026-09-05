import { describe, expect, it } from 'vitest'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { MACOS_BASH_PROFILE } from './shell/shellProfiles'

describe('toolsConfigRuntime shell profile snapshot', () => {
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
