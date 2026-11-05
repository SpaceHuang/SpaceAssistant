import { describe, expect, it } from 'vitest'
import type { ApprovalCluePack, ApprovalScriptEvidence } from './types'

describe('ApprovalScriptEvidence contract', () => {
  it('models complete, bounded evidence with an optional clue field', () => {
    const evidence: ApprovalScriptEvidence = {
      coverage: 'complete', totalCount: 1, truncated: false, contentDigest: 'sha256:script', sufficiency: 'sufficient',
      findings: [{
        pattern: 'A1', class: 'process-creation', range: { startLine: 2, startCol: 1, endLine: 2, endCol: 20 },
        snippet: 'subprocess.Popen(args)', evidence: { kind: 'process-create', module: 'subprocess', attr: 'Popen' }, status: 'complete'
      }]
    }
    const withEvidence: ApprovalCluePack = {
      toolName: 'run_script', actionClass: 'write', riskLevel: 'high', summary: 'review script', signals: ['script-analysis'], scriptEvidence: evidence
    }
    const legacyClue: ApprovalCluePack = {
      toolName: 'run_script', actionClass: 'write', riskLevel: 'high', summary: 'legacy request', signals: ['script-analysis']
    }
    const incompleteEvidence: ApprovalScriptEvidence = {
      ...evidence, coverage: 'partial', sufficiency: 'undetermined', truncated: true,
      findings: [{ ...evidence.findings[0]!, snippet: null, status: 'insufficient' }]
    }

    expect(withEvidence.scriptEvidence).toEqual(evidence)
    expect(legacyClue.scriptEvidence).toBeUndefined()
    expect(incompleteEvidence).toMatchObject({ coverage: 'partial', sufficiency: 'undetermined', truncated: true,
      findings: [{ snippet: null, status: 'insufficient' }] })
  })
})
