import { describe, expect, it } from 'vitest'
import { parseShellResultData } from './shellToolDisplay'

describe('parseShellResultData', () => {
  it('保留生命周期、输出 artifact 和终止确认字段', () => {
    expect(parseShellResultData({
      status: 'timed_out', signal: 'SIGTERM', terminationReason: 'timeout', treeKillVerified: true,
      durationMs: 123, stdoutBytes: 10, stderrBytes: 2, outputArtifactBytes: 12,
      outputArtifactSha256: 'a'.repeat(64), caseId: 'SHELL-LIFECYCLE-001'
    })).toMatchObject({ status: 'timed_out', signal: 'SIGTERM', treeKillVerified: true, outputArtifactBytes: 12 })
  })

  it('拒绝未知 status 和错误类型字段', () => {
    const result = parseShellResultData({ status: 'unknown', durationMs: '123', treeKillVerified: 'yes' })
    expect(result?.status).toBeUndefined()
    expect(result?.durationMs).toBeUndefined()
    expect(result?.treeKillVerified).toBeUndefined()
  })
})
