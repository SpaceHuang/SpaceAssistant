import { describe, expect, it } from 'vitest'
import { createOutputPipelineSnapshot } from './outputPipeline'

describe('createOutputPipelineSnapshot', () => {
  it('统一输出边界、terminal raw 和 artifact 元数据，并冻结快照', () => {
    const snapshot = createOutputPipelineSnapshot({
      stdout: { text: 'head', bytes: 100, truncated: true },
      stderr: { text: 'err', bytes: 3, truncated: false },
      terminalRaw: Buffer.from('raw'), inlineMaxBytes: 1024, artifactMaxBytes: 2048,
      artifact: { path: '/tmp/out.log', bytes: 103, sha256: 'a'.repeat(64) }
    })
    expect(snapshot).toMatchObject({ terminalRawBytes: 3, terminalRawBase64: 'cmF3', truncated: true })
    expect(snapshot.artifact?.bytes).toBe(103)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.stdout)).toBe(true)
  })
})
