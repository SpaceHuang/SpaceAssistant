import { describe, expect, it } from 'vitest'
import { workspaceResourceKeys } from './builtinExecutors'

describe('builtin tool capability resource keys', () => {
  const context = { workDir: '/workspace/project', sessionId: 'session-1' }

  it('normalizes a safe relative path into a global workspace resource key', () => {
    expect(workspaceResourceKeys({ path: 'src/../src/app.ts' }, context, 'read')).toEqual([
      'workspace:/workspace/project/src/app.ts'
    ])
  })

  it('同一工作区文件在不同会话中使用同一个锁键', () => {
    expect(workspaceResourceKeys({ path: 'src/app.ts' }, context, 'write')).toEqual(
      workspaceResourceKeys({ path: 'src/app.ts' }, { ...context, sessionId: 'session-2' }, 'write')
    )
  })

  it('returns unknown for absolute or escaping paths so scheduler keeps a barrier', () => {
    expect(workspaceResourceKeys({ path: '/etc/passwd' }, context, 'read')).toBeUndefined()
    expect(workspaceResourceKeys({ path: '../secret' }, context, 'write')).toBeUndefined()
  })
})
