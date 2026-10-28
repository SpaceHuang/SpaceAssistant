import { describe, expect, it } from 'vitest'
import { projectAgentLogFields, projectRendererLongTaskMessage, projectRendererSessionSwitchTraceMessage } from './agentLogProjection'

describe('projectAgentLogFields', () => {
  it('accepts renderer long-task timing only from the private console envelope', () => {
    expect(projectRendererLongTaskMessage('[renderer.performance.long-task] {"kind":"long-animation-frame","startTimeMs":25.126,"durationMs":75.345,"blockingDurationMs":42.789,"scriptAttributionStatus":"present","scriptCandidateCount":2,"scriptAttributions":[{"file":"main-AbC123.js","functionName":"renderMessageList","durationMs":30.126,"path":"/private"}],"scripts":[{"sourceURL":"/private/path.js"}]}', 44))
      .toEqual({ kind: 'long-animation-frame', startTimeMs: 25.13, durationMs: 75.35, blockingDurationMs: 42.79, rendererProcessId: 44,
        scriptAttributionStatus: 'present', scriptCandidateCount: 2,
        scriptAttributions: [{ file: 'main-AbC123.js', functionName: 'renderMessageList', durationMs: 30.13 }] })
    expect(projectRendererLongTaskMessage('[renderer.performance.long-task] {"kind":"longtask","startTimeMs":1,"durationMs":49}', 44)).toBeUndefined()
    expect(projectRendererLongTaskMessage('[renderer.performance.long-task] not-json', 44)).toBeUndefined()
    expect(projectRendererLongTaskMessage('[renderer.performance.long-task] {"kind":"longtask","startTimeMs":1,"durationMs":80,"path":"/private"}', 44))
      .toEqual({ kind: 'longtask', startTimeMs: 1, durationMs: 80, rendererProcessId: 44 })
  })

  it('retains only validated renderer long-task timing fields', () => {
    expect(projectAgentLogFields('renderer.long-task', {
      kind: 'longtask', startTimeMs: 1, durationMs: 80, blockingDurationMs: 4, rendererProcessId: 44,
      scriptAttributions: [{ file: 'main-AbC123.js', functionName: 'renderMessageList', durationMs: 60 }],
      sourceURL: '/private/path.js', sessionId: 'private-session'
    })).toEqual({ kind: 'longtask', startTimeMs: 1, durationMs: 80, rendererProcessId: 44,
      scriptAttributions: [{ file: 'main-AbC123.js', functionName: 'renderMessageList', durationMs: 60 }] })
  })

  it('accepts renderer switch timings only from the private console diagnostic envelope', () => {
    expect(projectRendererSessionSwitchTraceMessage('[session.switch.trace.renderer] {"event":"session.switch.trace","instance":"renderer","rendererProcessId":44,"requestOrdinal":8,"requestInitiatedAtEpochMs":1798000000123,"outcome":"ok","pageSize":20,"stages":[{"name":"selection-to-page-request","durationMs":4.5,"outcome":"ok"},{"name":"renderer-page-request","durationMs":3.4,"outcome":"ok"}],"private":"body"}'))
      .toEqual({ instance: 'renderer', traceId: '44-8', rendererProcessId: 44, requestOrdinal: 8,
        requestInitiatedAtEpochMs: 1_798_000_000_123,
        outcome: 'ok', pageSize: 20, stages: [
          { name: 'selection-to-page-request', durationMs: 4.5, outcome: 'ok' },
          { name: 'renderer-page-request', durationMs: 3.4, outcome: 'ok' }
        ] })
    expect(projectRendererSessionSwitchTraceMessage('[session.switch.trace.renderer] {"private":"body"}')).toBeUndefined()
    expect(projectRendererSessionSwitchTraceMessage('[session.switch.trace.renderer] not-json')).toBeUndefined()
    expect(projectRendererSessionSwitchTraceMessage('[session.switch.trace.renderer] {"event":"session.switch.trace","instance":"renderer","requestOrdinal":9,"outcome":"ok","pageSize":20,"stages":[]}', 55))
      .toEqual({ instance: 'renderer', traceId: '55-9', rendererProcessId: 55, requestOrdinal: 9,
        outcome: 'ok', pageSize: 20, stages: [] })
    expect(projectRendererSessionSwitchTraceMessage('[session.switch.trace.renderer] {"event":"session.switch.trace","instance":"renderer","rendererProcessId":44,"requestOrdinal":9,"outcome":"ok","pageSize":20,"stages":[]}', 55)).toBeUndefined()
  })

  it('retains bounded projection slice metrics without scope or payload data', () => {
    expect(projectAgentLogFields('session.projection.build.slice', {
      durationMs: 9.2, nextSequence: 400, outcome: 'checkpointed', yielded: true,
      scopeKey: 'private-scope', payload: 'private-body'
    })).toEqual({ durationMs: 9.2, nextSequence: 400, outcome: 'checkpointed', yielded: true })
  })

  it('retains only safe per-turn tool execution counts', () => {
    const projected = projectAgentLogFields('tools.execution_summary', {
      requestId: 'request-1', turnId: 'turn-1', proposalCount: 4, executorEntryCount: 1,
      knownFailureCount: 0, unknownOutcomeCount: 1, notDispatchedCount: 2,
      input: { token: 'private' }, toolCalls: ['private']
    })
    expect(projected).toMatchObject({
      requestId: 'request-1', turnId: 'turn-1', proposalCount: 4, executorEntryCount: 1,
      knownFailureCount: 0, unknownOutcomeCount: 1, notDispatchedCount: 2
    })
    expect(projected.inputFingerprint).toEqual(expect.any(String))
    expect(projected).not.toHaveProperty('input')
    expect(projected).not.toHaveProperty('toolCalls')
    expect(JSON.stringify(projected)).not.toContain('private')
  })

  it('retains cutover and transcript reconciliation counters without message content', () => {
    expect(projectAgentLogFields('history.cutover', {
      requestId: 'request-1', turnId: 'turn-1', sessionId: 'session-1', stage: 'match-current-message',
      reasonCode: 'matched', historyStreamId: 'legacy-stream', previousTurnId: 'previous-turn', snapshotVersion: 7,
      message: 'must not be retained'
    })).toEqual({
      requestId: 'request-1', turnId: 'turn-1', sessionId: 'session-1', stage: 'match-current-message',
      reasonCode: 'matched', historyStreamId: 'legacy-stream', previousTurnId: 'previous-turn', snapshotVersion: 7
    })
    expect(projectAgentLogFields('session.transcript.reconciliation', {
      sessionId: 'session-1', turnId: 'turn-1', outcome: 'commit_uncertain', reasonCode: 'version-conflict', transcriptVersion: 4, reconciledCount: 1
    })).toMatchObject({ outcome: 'commit_uncertain', transcriptVersion: 4, reconciledCount: 1 })
    expect(projectAgentLogFields('session.transcript.reconciliation', {
      outcome: 'startup-scan', releasedUnstarted: 2, markedUncertain: 1, repairedCheckpoints: 1, reconciledCount: 1,
      message: 'must not be retained'
    })).toEqual({ outcome: 'startup-scan', releasedUnstarted: 2, markedUncertain: 1, repairedCheckpoints: 1, reconciledCount: 1 })
  })

  it('retains only the accepted input fingerprint comparison outcome in storage shadow diagnostics', () => {
    expect(projectAgentLogFields('session.storage.shadow', {
      sessionId: 'session-1', consumer: 'api-context', source: 'canonical:L2', status: 'matched',
      differenceCount: 0, fieldNames: [], acceptedInputFingerprint: 'matched', fingerprint: 'private digest',
      content: 'private accepted input'
    })).toEqual({
      sessionId: 'session-1', consumer: 'api-context', source: 'canonical:L2', status: 'matched',
      differenceCount: 0, fieldNames: [], acceptedInputFingerprint: 'matched'
    })
  })

  it('retains transcript read outcome and timing while discarding transcript or arbitrary error fields', () => {
    expect(projectAgentLogFields('session.transcript.read', {
      sessionId: 'session-1', consumer: 'transcript', source: 'canonical:L2', outcome: 'canonical', durationMs: 14,
      errorCode: 'CANONICAL_SESSION_CONTENT_UNAVAILABLE', content: 'private transcript', message: 'sensitive error detail'
    })).toEqual({
      sessionId: 'session-1', consumer: 'transcript', source: 'canonical:L2', outcome: 'canonical', durationMs: 14,
      errorCode: 'CANONICAL_SESSION_CONTENT_UNAVAILABLE'
    })
  })

  it('retains only structured startup history recovery facts', () => {
    expect(projectAgentLogFields('session.history.recovery', {
      outcome: 'degraded', reconciledCount: 2, failed: 1, pendingRepairs: 173, durationMs: 43, errorCode: 'HISTORY_RECOVERY_FAILED',
      message: 'private recovery detail'
    })).toEqual({ outcome: 'degraded', reconciledCount: 2, failed: 1, pendingRepairs: 173, durationMs: 43, errorCode: 'HISTORY_RECOVERY_FAILED' })
  })

  it('records per-session ledger gate operation counts and latency without a session id or path', () => {
    expect(projectAgentLogFields('session.history.recovery', {
      kind: 'session-ledger-gate', phase: 'target', status: 'ready', durationMs: 9,
      baselineScanCount: 0, projectedCount: 2, failureClass: null,
      sessionId: 'private-session', workDir: '/private/workspace'
    })).toEqual({ kind: 'session-ledger-gate', phase: 'target', status: 'ready', durationMs: 9, baselineScanCount: 0, projectedCount: 2 })
  })

  it('keeps per-stage history repair diagnostics while discarding error messages and identifiers', () => {
    expect(projectAgentLogFields('session.history.repair.failed', {
      kind: 'tool-result', reasonCode: 'canonical-projection-rejected',
      invocationId: 'private-invocation', toolCallId: 'private-tool',
      error: 'private-session transcript and /Users/private/path'
    })).toEqual({ kind: 'tool-result', reasonCode: 'canonical-projection-rejected', errorRedacted: true })
  })

  it('keeps source-truth spill collection diagnostics structural and free of file paths or content', () => {
    expect(projectAgentLogFields('storage.spill.source_truth_gc', {
      phase: 'reference-scan', pending: 3, completed: 1, sharedReference: 1, failed: 1,
      locator: '01234567-89ab-cdef-0123-456789abcdef.spill', payload: 'private transcript body', path: '/private/userData/spill'
    })).toEqual({ phase: 'reference-scan', pending: 3, completed: 1, sharedReference: 1, failed: 1 })
    expect(projectAgentLogFields('storage.spill.source_truth_gc_failed', {
      phase: 'reference-scan', pending: 2, reason: 'SyntaxError', payload: 'private transcript body'
    })).toEqual({ phase: 'reference-scan', pending: 2, reason: 'SyntaxError' })
  })

  it('retains the structured facts needed to audit silent context overflow', () => {
    expect(projectAgentLogFields('llm.silent_overflow', {
      requestId: 'req:round:1',
      sessionId: 'session-1',
      model: 'deepseek-v4-pro',
      llmServiceId: 'service-1',
      kind: 'usage-exceeds-window',
      inputTokens: 100_001,
      contextWindow: 100_000,
      stopReason: 'end_turn',
      privateText: 'must be discarded'
    })).toEqual({
      requestId: 'req:round:1',
      sessionId: 'session-1',
      model: 'deepseek-v4-pro',
      llmServiceId: 'service-1',
      kind: 'usage-exceeds-window',
      inputTokens: 100_001,
      contextWindow: 100_000,
      stopReason: 'end_turn'
    })
  })

  it('projects grep termination facts without retaining paths or search input', () => {
    expect(projectAgentLogFields('grep.terminate', {
      requestId: 'request-1', sessionId: 'session-1', toolUseId: 'tool-1', reason: 'abort',
      terminated: 'graceful', elapsedMs: 275, treeKillVerified: true, terminationState: 'terminated',
      pattern: 'private search', cwd: '/private/worktree', path: '/private/file'
    })).toEqual({
      requestId: 'request-1', sessionId: 'session-1', toolUseId: 'tool-1', reason: 'abort',
      terminated: 'graceful', elapsedMs: 275, treeKillVerified: true, terminationState: 'terminated'
    })
  })

  it('keeps cancellation audit fields visible after projection (turn.cancel / turn.cancel.tools / llm.cancel)', () => {
    // 字段清单 ↔ COMMON_KEYS 逐项对照（N8）：accepted / cancelledTools / abortToCatchMs
    // 缺任何一个键，对应审计事件在投影后整字段丢失，验收标准 3 不成立
    expect(projectAgentLogFields('turn.cancel', {
      turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', accepted: true,
      privateDetail: 'must be discarded'
    })).toEqual({ turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', accepted: true })
    expect(projectAgentLogFields('turn.cancel.tools', {
      turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', cancelledTools: 2,
      privateDetail: 'must be discarded'
    })).toEqual({ turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', cancelledTools: 2 })
    expect(projectAgentLogFields('llm.cancel', {
      requestId: 'request-1', sessionId: 'session-1', loopRound: 1, abortToCatchMs: 42,
      privateDetail: 'must be discarded'
    })).toEqual({ requestId: 'request-1', sessionId: 'session-1', loopRound: 1, abortToCatchMs: 42 })
  })
})
