import { describe, expect, it } from 'vitest'
import { readSkillsToolExecutor } from './skillsReadTool'

describe('skills.read tool', () => {
  it('rejects arbitrary paths and accepts only a bounded registered name', async () => {
    const result = await readSkillsToolExecutor({ name: '../secret', max_chars: 100 }, {
      workDir: '/tmp/nonexistent', userDataDir: '/tmp/nonexistent', requestId: 'r', toolUseId: 'u', sessionId: 's',
      sendProgress: () => {}, signal: new AbortController().signal, fileStateCache: {} as never, toolsConfig: {} as never
    })
    expect(result.success).toBe(false)
  })
})
