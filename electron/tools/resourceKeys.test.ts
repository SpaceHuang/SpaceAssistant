import { describe, expect, it } from 'vitest'
import path from 'path'
import { workspaceResourceKeys } from './builtinExecutors'

describe('builtin tool capability resource keys', () => {
  const context = { workDir: '/workspace/project', sessionId: 'session-1' }

  it('normalizes a safe relative path into a global workspace resource key', () => {
    // 资源身份是平台原生绝对路径（path.resolve / realpath 兜底），Windows 上含盘符与反斜杠，
    // 期望值必须由同一 path 语义推导，不能写死 posix 字面量
    expect(workspaceResourceKeys({ path: 'src/../src/app.ts' }, context, 'read')).toEqual([
      `workspace:${path.resolve(context.workDir, 'src/app.ts')}`
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
