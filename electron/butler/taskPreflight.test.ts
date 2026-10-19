import { describe, expect, it, vi } from 'vitest'
import { runTaskPreflight, type TaskPreflightAnalyzer } from './taskPreflight'

describe('runTaskPreflight', () => {
  it('classifies a truncated model response as an incomplete result instead of an unknown schema error', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('PREFLIGHT_MODEL_TRUNCATED_RESPONSE') }) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_OUTPUT_TRUNCATED', messageKey: 'butler.preflight.analyzer_output_truncated' }] })
  })

  it('explains a truncated first-stage rehearsal with the same output-limit issue', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [], mockIncomplete: true, mockIncompleteReason: 'PREFLIGHT_MODEL_TRUNCATED_RESPONSE' } as never)) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_OUTPUT_TRUNCATED', messageKey: 'butler.preflight.analyzer_output_truncated' }] })
  })

  it('passes only with complete facts and an unambiguous structured target', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: 'report.csv', targetType: 'file' }] })) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv and summarize it', scheduleSummary: 'daily 09:00', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 4 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace/report.csv', relativePath: 'report.csv', kind: 'file' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })
    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, bindings: [{ kind: 'exact', path: '/workspace/report.csv', taskRevision: 4 }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Read report.csv and summarize it', authorizedRoots: ['/workspace'], outputRoot: undefined, facts: expect.any(Object), tools: [] }), expect.any(AbortSignal))
  })

  it('validates MCP requirements against host-provided tool descriptors and passes the catalog to analysis', async () => {
    const mcpTools = [{
      serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues',
      description: 'Search issues', parameters: [{ name: 'query', type: 'string', required: false }],
      descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64)
    }]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'mcp', serverId: 'server-1', toolName: 'search_issues', purpose: '查找最近更新的问题' }]
    } as never)) }
    const result = await runTaskPreflight({
      prompt: '查找最近更新的问题', scheduleSummary: 'daily', deliverySummary: 'desktop',
      roots: ['/workspace'], taskRevision: 1, mcpTools
    } as never, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })

    expect(result.report.status).toBe('passed')
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({
      mcpTools: [{ serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues', parameters: [{ name: 'query', type: 'string', required: false }] }]
    }), expect.any(AbortSignal))
    expect(result.requiredPermissions).toEqual([{ tool: 'mcp', serverId: 'server-1', toolName: 'search_issues', purpose: '查找最近更新的问题' }])
  })

  it('rejects a model-invented MCP server or tool instead of creating a task grant', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'mcp', serverId: 'invented-server', toolName: 'delete_everything', purpose: '执行任务' }]
    } as never)) }
    const result = await runTaskPreflight({
      prompt: '完成工作', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1,
      mcpTools: [{ serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search', parameters: [], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64) }]
    } as never, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })

    expect(result.report.status).toBe('unavailable')
    expect(result.requiredPermissions).toBeUndefined()
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

  it('reports a missing Git repository instead of claiming the prompt lacks a file location', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'git_repository_not_found' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'no-git-repository' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'TARGET_NOT_FOUND',
      reference: prompt,
      reasonCode: 'git_repository_not_found'
    })])
  })

  it('offers the selected output Git repository as a separate read authorization candidate', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [
        { reference: prompt, reasonCode: 'target_missing' },
        { reference: prompt, reasonCode: 'output_root_not_read_authorized' }
      ]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/project', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({
        roots: [], outputRoot: '/project', outputRootIsGitRepository: true, gitRepositories: [], entries: [],
        coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-git-candidate'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', reference: prompt, reasonCode: 'output_root_not_read_authorized', candidates: ['/project'] }],
      suggestedDirectories: [{ path: '/project', purposeKey: 'butler.preflight.output_root_read_candidate_purpose', validationStatus: 'valid' }]
    })
    expect(result.report.suggestedDirectories[0]?.purposeKey).toBe('butler.preflight.output_root_read_candidate_purpose')
    expect(result.bindings).toEqual([])
  })

  it('turns a Shell request targeting the output Git repository into an explicit read-authorization clarification', async () => {
    const prompt = '总结一下本地 Git 历史'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/project' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: '/project' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/daily'], outputDir: '/project', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({
        roots: ['/daily'], outputRoot: '/project', outputRootIsGitRepository: true, gitRepositories: [],
        entries: [{ path: '/daily', relativePath: '', kind: 'directory' as const }],
        coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'output-git-read-not-authorized'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', field: 'workDirs', reference: prompt, reasonCode: 'output_root_not_read_authorized', candidates: ['/project'] }],
      suggestedDirectories: [{ path: '/project', purposeKey: 'butler.preflight.output_root_read_candidate_purpose', validationStatus: 'valid' }]
    })
    expect(result.requiredPermissions).toBeUndefined()
    expect(result.bindings).toEqual([])
  })

  it('asks the user to add a repository directory when a Git request has no authorized roots', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'capability_not_authorized' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'no-authorized-roots' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'TOOL_PERMISSION_REQUIRED',
      reference: prompt,
      reasonCode: 'capability_not_authorized'
    })])
  })

  it('returns a Shell permission requirement for a Git history task without treating it as already authorized', async () => {
    const requiredPermissions = [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace', timeout: 60 }]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredPermissions } as never)) }
    const result = await runTaskPreflight({
      prompt: '总结昨天合并进 main 的提交', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'],
      taskRevision: 2
    }, { analyzer, factsProvider: { collect: vi.fn(async () => ({
      roots: ['/workspace'], gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }],
      coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'git-facts'
    })) } })

    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, bindings: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }] })
    expect(result.requiredPermissions).toEqual([{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }])
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ gitRepositories: ['/workspace'] }) }), expect.any(AbortSignal))
  })

  it('returns a Shell permission request for confirmation instead of blocking on missing authorization', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt: '总结昨天合并进 main 的提交', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'git-facts' })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }] })
  })

  it('supports explicitly scoped grep and per-script hash review requirements', async () => {
    const requiredPermissions = [
      { tool: 'grep', scopeRoots: ['/workspace/src'] },
      { tool: 'run_script', scopeRoots: ['/workspace'] }
    ]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredPermissions
    } as never)) }
    const result = await runTaskPreflight({ prompt: '搜索并整理代码', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 3 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const },
        { path: '/workspace/src', relativePath: 'src', kind: 'directory' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 2, errors: 0 }, digest: 'facts' })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed' }, requiredPermissions })
  })

  it('rejects Shell argument scopes whose working directory is outside host facts', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log', workingDirectory: '/outside' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt: '查看提交', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
    expect(result.requiredPermissions).toBeUndefined()
  })

  it('fails closed when a requested Shell permission has no user-selected directory scope', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'output', path: 'summary.txt', expectedType: 'file' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log', workingDirectory: '/results' }]
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

  it('returns unavailable on model request errors and never exposes tools', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('provider unavailable') }) }
    const result = await runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })
    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_UNAVAILABLE' }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }), expect.any(AbortSignal))
  })

  it('blocks task confirmation when the mock exercise reaches a hard limit', async () => {
    const mockTrace = [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'release', path: '/workspace' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [], requiredPermissions: [], clarifications: [], suggestedDirectories: [], mockTrace, mockIncomplete: true
    } as never)) }
    const result = await runTaskPreflight({ prompt: 'Find release notes', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result).toMatchObject({
      report: { status: 'blocked', blockers: [{ code: 'MOCK_PREFLIGHT_INCOMPLETE' }] },
      bindings: [], mockTrace
    })
  })

  it('reports a model response parsing failure separately from a failed model call', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('PREFLIGHT_MODEL_INVALID_JSON') }) }
    const result = await runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
  })

  it('reports a summary request timeout separately from the whole-preflight timeout', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('PREFLIGHT_MODEL_SUMMARY_TIMEOUT') }) }
    const result = await runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_SUMMARY_TIMEOUT' }] })
  })

  it('allows up to 60 seconds for the selected model to finish preflight', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn((_input, requestSignal) => {
        signal = requestSignal
        return new Promise(() => undefined)
      }) }
      const pending = runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })

      await vi.advanceTimersByTimeAsync(15_000)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(44_999)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      expect(signal?.aborted).toBe(true)
      await expect(pending).resolves.toMatchObject({ report: { status: 'unavailable', blockers: [{ code: 'ANALYZER_TIMEOUT' }] } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts facts collection against the single whole-preflight deadline', async () => {
    vi.useFakeTimers()
    try {
      let analysisInput: { remainingBudgetMs: number } | undefined
      let signal: AbortSignal | undefined
      const factsProvider = { collect: vi.fn(() => new Promise<{
        roots: string[]; gitRepositories: string[]; entries: Array<{ path: string; relativePath: string; kind: 'directory' }>
        coverage: { complete: boolean; truncated: boolean; roots: number; visited: number; errors: number }; digest: string
      }>((resolve) => setTimeout(() => resolve({
        roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' }],
        coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts'
      }), 55_000))) }
      const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn((input, requestSignal) => {
        analysisInput = input
        signal = requestSignal
        return new Promise(() => undefined)
      }) }
      const pending = runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
        analyzer, factsProvider, timeoutMs: 60_000
      })

      await vi.advanceTimersByTimeAsync(55_000)
      expect(analysisInput?.remainingBudgetMs).toBeLessThanOrEqual(5_000)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      expect(signal?.aborted).toBe(true)
      await expect(pending).resolves.toMatchObject({ report: { status: 'unavailable', blockers: [{ code: 'ANALYZER_TIMEOUT' }] } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed or unsupported analyzer output as unavailable', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'collection', directory: '/workspace', selector: '**/*' }] } as never)) }
    const result = await runTaskPreflight({ prompt: 'enumerate', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })
    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
  })

  it('rejects unsupported requested tools instead of displaying or granting them', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredPermissions: [{ tool: 'run_arbitrary' }] } as never)) }
    const result = await runTaskPreflight({ prompt: 'inspect', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
    expect(result.requiredPermissions).toBeUndefined()
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
    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_TIMEOUT' }] })
  })
})
