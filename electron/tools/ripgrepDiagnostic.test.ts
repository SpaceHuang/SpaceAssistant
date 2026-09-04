import { describe, expect, it } from 'vitest'
import { createGrepRipgrepDiagnostic } from './builtinExecutors'

describe('grep ripgrep diagnostic contract', () => {
  it('允许的诊断字段不包含敏感搜索输入', () => {
    const message = createGrepRipgrepDiagnostic({ source: 'bundled', platform: 'darwin', arch: 'arm64', path: '/resources/bin/rg' })
    expect(message).not.toMatch(/pattern|cwd|workdir|filename|命中/)
    expect(message).toContain('source=bundled')
  })

  it('不可用时只记录稳定的环境和状态字段', () => {
    const message = createGrepRipgrepDiagnostic({ source: 'unavailable', platform: 'win32', arch: 'x64', path: null })
    expect(message).toBe('source=unavailable;platform=win32;arch=x64;status=unavailable')
    expect(message).not.toMatch(/pattern|cwd|workdir|filename|resources\/bin/)
  })
})
