import { describe, expect, it } from 'vitest'
import { inspectRemoteAsyncApprovalAcceptanceMatrix } from './remoteAsyncApprovalAcceptanceMatrix'

describe('remote asynchronous approval acceptance matrix', () => {
  it('maps every security acceptance row to an existing local test file and named case', () => {
    const result = inspectRemoteAsyncApprovalAcceptanceMatrix()
    expect(result.complete, result.missing.map((entry) => `${entry.requirement}: ${entry.reference}`).join('\n')).toBe(true)
    expect(result.coveredRequirements.join('\n')).toContain('develop v0.2 §12')
    expect(result.coveredRequirements.join('\n')).toContain('OQ-8')
    expect(result.coveredRequirements.join('\n')).toContain('P1-7')
    expect(result.coveredRequirements.join('\n')).toContain('G1–G4')
    expect(result.coveredRequirements.join('\n')).toContain('§15.6 F1–F4')
    expect(result.coveredRequirements.join('\n')).toContain('历轮设计/开发计划评审')
  })

  it('rejects a traceability row whose target test is missing', () => {
    const result = inspectRemoteAsyncApprovalAcceptanceMatrix({ rows: [
      { requirement: 'P1-1', references: [{ file: 'electron/confirmation/does-not-exist.test.ts', testName: 'missing-case' }] }
    ] })
    expect(result.complete).toBe(false)
    expect(result.missing).toEqual(expect.arrayContaining([expect.objectContaining({ requirement: 'P1-1' })]))
  })
})
