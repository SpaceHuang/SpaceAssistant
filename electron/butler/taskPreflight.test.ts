import { describe, expect, it, vi } from 'vitest'
import { runTaskPreflight, type TaskPreflightAnalyzer } from './taskPreflight'

describe('runTaskPreflight', () => {
  it('passes only with complete facts and an unambiguous structured target', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: 'report.csv', targetType: 'file' }] })) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv and summarize it', scheduleSummary: 'daily 09:00', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 4 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace/report.csv', relativePath: 'report.csv', kind: 'file' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })
    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, bindings: [{ kind: 'exact', path: '/workspace/report.csv', taskRevision: 4 }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Read report.csv and summarize it', authorizedRoots: ['/workspace'], outputRoot: undefined, facts: expect.any(Object), tools: [] }), expect.any(AbortSignal))
  })

  it('keeps an output-only task separate from authorized read roots', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'output', path: 'result.txt', expectedType: 'file' }] })) }
    const result = await runTaskPreflight({ prompt: 'write result.txt', scheduleSummary: 'once', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 2 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-only' })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed' }, bindings: [{ kind: 'output', path: '/results/result.txt', ancestor: '/results' }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ authorizedRoots: [], outputRoot: '/results' }), expect.any(AbortSignal))
  })

  it('preserves the unclear source phrase and reason when the model cannot identify a target', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [{ reference: '帮我处理一下', reasonCode: 'scope_unclear' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt: '帮我处理一下', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'TARGET_UNCLEAR',
      messageKey: 'butler.preflight.target_unclear',
      reference: '帮我处理一下',
      reasonCode: 'scope_unclear'
    })])
  })

  it('returns a Shell permission requirement for a Git history task without treating it as already authorized', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredTools: ['run_shell'] } as never)) }
    const result = await runTaskPreflight({
      prompt: '总结昨天合并进 main 的提交', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'],
      taskRevision: 2
    }, { analyzer, factsProvider: { collect: vi.fn(async () => ({
      roots: ['/workspace'], gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }],
      coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'git-facts'
    })) } })

    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, bindings: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredTools: ['run_shell'] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ gitRepositories: ['/workspace'] }) }), expect.any(AbortSignal))
  })

  it('returns a Shell permission request for confirmation instead of blocking on missing authorization', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredTools: ['run_shell']
    } as never)) }
    const result = await runTaskPreflight({ prompt: '总结昨天合并进 main 的提交', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'git-facts' })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, requiredTools: ['run_shell'] })
  })

  it('fails closed when a requested Shell permission has no user-selected directory scope', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'output', path: 'summary.txt', expectedType: 'file' }], requiredTools: ['run_shell']
    } as never)) }
    const result = await runTaskPreflight({ prompt: '查询 Git 并生成摘要', scheduleSummary: 'once', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-only' })) }
    })

    expect(result.report).toMatchObject({ status: 'blocked', blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', field: 'workDirs' }] })
    expect(result.bindings).toEqual([])
  })

  it('shows the exact reference and every matching path for an ambiguous target', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: 'report.csv', targetType: 'file' }] })) }
    const result = await runTaskPreflight({ prompt: '读取 report.csv', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], entries: [
        { path: '/workspace/a/report.csv', relativePath: 'a/report.csv', kind: 'file' as const },
        { path: '/workspace/b/report.csv', relativePath: 'b/report.csv', kind: 'file' as const }
      ], gitRepositories: [], coverage: { complete: true, truncated: false, roots: 1, visited: 2, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'TARGET_AMBIGUOUS',
      messageKey: 'butler.preflight.target_ambiguous',
      reference: 'report.csv',
      candidates: ['/workspace/a/report.csv', '/workspace/b/report.csv']
    })])
  })

  it('blocks ambiguity, unknown scope, and incomplete coverage', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: 'report.csv', targetType: 'file' }] })) }
    const factsProvider = { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
      { path: '/workspace/a/report.csv', relativePath: 'a/report.csv', kind: 'file' as const },
      { path: '/workspace/b/report.csv', relativePath: 'b/report.csv', kind: 'file' as const }
    ], coverage: { complete: false, truncated: true, roots: 1, visited: 2, errors: 0 }, digest: 'partial' })) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv', scheduleSummary: 'interval', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 0 }, { analyzer, factsProvider })
    expect(result.report).toMatchObject({ status: 'blocked' })
    expect(result.bindings).toEqual([])
    expect(result.report.blockers.map((item) => item.code)).toContain('FACTS_INCOMPLETE')
  })

  it('returns unavailable on model error or timeout and never exposes tools', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('provider unavailable') }) }
    const result = await runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })
    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_UNAVAILABLE' }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }), expect.any(AbortSignal))
  })

  it('rejects malformed or unsupported analyzer output as unavailable', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'collection', directory: '/workspace', selector: '**/*' }] } as never)) }
    const result = await runTaskPreflight({ prompt: 'enumerate', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })
    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
  })

  it('rejects unsupported requested tools instead of displaying or granting them', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredTools: ['run_arbitrary'] } as never)) }
    const result = await runTaskPreflight({ prompt: 'inspect', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
    expect(result.requiredTools).toBeUndefined()
  })

  it('aborts the analyzer on timeout and fails closed', async () => {
    let signal: AbortSignal | undefined
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn((_input, requestSignal) => {
      signal = requestSignal
      return new Promise(() => undefined)
    }) }
    const result = await runTaskPreflight({ prompt: 'read file', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 0 }, {
      analyzer,
      timeoutMs: 5,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) }
    })
    expect(signal?.aborted).toBe(true)
    expect(result.report.status).toBe('unavailable')
  })
})
