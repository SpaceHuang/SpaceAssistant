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

  it('summarizes the valid trace collected before a first-stage output limit', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace/report.csv', targetType: 'file' }],
      requiredPermissions: [{ tool: 'grep', scopeRoots: ['/workspace'] }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'report', path: '/workspace' }, dispatch: 'simulated', resultKind: 'synthetic' }],
      mockIncomplete: true, mockIncompleteReason: 'PREFLIGHT_MODEL_TRUNCATED_RESPONSE'
    } as never)) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv', scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const },
        { path: '/workspace/report.csv', relativePath: 'report.csv', kind: 'file' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 2, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'passed', blockers: [], preflightCoverage: 'partial' })
  })

  it('passes only with complete facts and an unambiguous structured target', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: 'report.csv', targetType: 'file' }] })) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv and summarize it', scheduleSummary: 'daily 09:00', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 4 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace/report.csv', relativePath: 'report.csv', kind: 'file' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })
    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, bindings: [{ kind: 'exact', path: '/workspace/report.csv', taskRevision: 4 }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Read report.csv and summarize it', authorizedRoots: ['/workspace'], outputRoot: undefined, facts: expect.any(Object), tools: [] }), expect.any(AbortSignal))
  })

  it('validates MCP requirements against host-provided tool descriptors and passes the catalog to analysis', async () => {
    const mappedName = 'mcp_issue_search'
    const mcpTools = [{
      serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues',
      description: 'Search issues', parameters: [{ name: 'query', type: 'string', required: false }],
      descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64), mappedName
    }]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      // A stale or incorrect model-authored permission is ignored. Only this host-recorded call
      // can produce an MCP grant, and the host supplies its stable purpose text.
      requiredPermissions: [{ tool: 'mcp', serverId: 'wrong-server', toolName: 'delete_everything', purpose: '错误' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: mappedName, input: { query: 'recent' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({
      prompt: '查找最近更新的问题', scheduleSummary: 'daily', deliverySummary: 'desktop',
      roots: ['/workspace'], taskRevision: 1, mcpTools
    } as never, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })

    expect(result.report.status).toBe('passed')
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({
      mcpTools: [{ serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues', parameters: [{ name: 'query', type: 'string', required: false }], mappedName }]
    }), expect.any(AbortSignal))
    expect(result.requiredPermissions).toEqual([{ tool: 'mcp', serverId: 'server-1', toolName: 'search_issues', purpose: '按任务调用此 MCP 工具' }])
  })

  it('rejects a model-invented MCP server or tool instead of creating a task grant', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'mcp', serverId: 'server-1', toolName: 'search_issues', purpose: '执行任务' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'mcp_invented_delete', input: {}, dispatch: 'simulated', resultKind: 'synthetic' }]
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
      blockers: [{ code: 'TOOL_PERMISSION_DETAILS_MISSING', reference: prompt, reasonCode: 'output_root_not_read_authorized', candidates: ['/project'] }],
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
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: '/project' }, dispatch: 'simulated', resultKind: 'synthetic' }],
      mockIncomplete: true, mockIncompleteReason: 'model_round_limit'
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/project', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({
        roots: [], outputRoot: '/project', outputRootIsGitRepository: true, gitRepositories: [], entries: [],
        coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-git-read-not-authorized'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      preflightCoverage: 'partial',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', field: 'workDirs', reference: prompt, reasonCode: 'output_root_not_read_authorized', candidates: ['/project'] }],
      suggestedDirectories: [{ path: '/project', purposeKey: 'butler.preflight.output_root_read_candidate_purpose', validationStatus: 'valid' }]
    })
    expect(result.requiredPermissions).toEqual([{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/project' }])
    expect(result.authorizationContinuation).toEqual({
      authorizedRoots: ['/project'],
      analysis: {
        targets: [],
        requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/project' }],
        mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: '/project' }, dispatch: 'simulated', resultKind: 'synthetic' }],
        mockIncomplete: true, mockIncompleteReason: 'model_round_limit'
      }
    })
    expect(result.bindings).toEqual([])
  })

  it('treats an explicitly named output Git repository as a read target when the summary model says its location is unclear', async () => {
    const root = '/Users/space/Documents/Develop/SpaceAssistant'
    const prompt = `总结一下${root} 项目昨天合并进main分支，并推送github的所有内容`
    const command = 'git log origin/main --merges --since="yesterday 00:00"'
    const analysis = {
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'no_target_identified' as const }],
      mockTrace: [{
        kind: 'proposed-tool-call' as const,
        toolName: 'run_shell',
        input: { command, workingDirectory: root },
        dispatch: 'simulated' as const,
        resultKind: 'synthetic' as const
      }]
    }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: root, taskRevision: 1 }, {
      analyzer: { analyze: vi.fn(async () => analysis) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [], entries: [],
        coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'explicit-output-git-target'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', reasonCode: 'output_root_not_read_authorized', candidates: [root] }],
      suggestedDirectories: [{ path: root, validationStatus: 'valid' }],
      permissionNeeds: expect.arrayContaining([
        { kind: 'directory-read-write', path: root },
        { kind: 'local-shell', scopeRoots: [root], commands: [{ command, workingDirectory: root }] }
      ])
    })
    expect(result.authorizationContinuation?.authorizedRoots).toEqual([root])

    const continuation = result.authorizationContinuation
    expect(continuation).toBeDefined()
    const approved = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], outputDir: root, taskRevision: 1,
      analysisOverride: continuation!.analysis
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('confirmation recheck must reuse the reviewed analysis') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [root],
        entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'approved-explicit-output-git-target'
      })) }
    })
    expect(approved.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(approved.requiredPermissions).toEqual([{ tool: 'run_shell', command, workingDirectory: root }])
  })

  it('recognizes the explicitly named output Git directory even when the rehearsal records no tool calls', async () => {
    const root = '/Users/space/Documents/Develop/SpaceAssistant'
    const prompt = `总结一下${root}项目昨天合并进main分支，并推送github的所有内容`
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: root, taskRevision: 1 }, {
      analyzer: { analyze: vi.fn(async () => ({
        targets: [],
        clarifications: [{ reference: prompt, reasonCode: 'no_target_identified' as const }],
        mockTrace: []
      })) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [], entries: [],
        coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'explicit-output-git-target-no-trace'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_DETAILS_MISSING', reasonCode: 'output_root_not_read_authorized', candidates: [root] }],
      suggestedDirectories: [{ path: root, validationStatus: 'valid' }]
    })
    expect(result.report.blockers).not.toContainEqual(expect.objectContaining({ code: 'TARGET_UNCLEAR' }))
    expect(result.authorizationContinuation).toBeUndefined()
  })

  it('derives an external directory candidate from the recorded Shell call, not by scanning prompt text', async () => {
    const root = '/Users/space/Documents/Develop/SpaceAssistant'
    const prompt = `总结一下${root} 项目昨天合并进main分支，并推送github的所有内容`
    let observedFactsBeforeRehearsal: unknown
    const inspectPaths = vi.fn(async (paths: readonly string[]) => paths.map((candidate) => ({
      path: candidate, kind: 'directory' as const, isGitRepository: true
    })))
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer: { analyze: vi.fn(async ({ facts }) => {
        observedFactsBeforeRehearsal = facts
        return {
          targets: [],
          mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: {
            command: 'git log origin/main --merges --since="yesterday 00:00"', workingDirectory: root
          }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
        }
      }) },
      factsProvider: {
        collect: vi.fn(async (_roots, outputRoot) => ({
          roots: [], outputRoot, gitRepositories: [], entries: [],
          coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'base-facts'
        })),
        inspectPaths
      }
    })

    expect(observedFactsBeforeRehearsal).not.toHaveProperty('proposedPathCandidates')
    expect(inspectPaths).toHaveBeenCalledWith([root])
    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED' }],
      permissionNeeds: expect.arrayContaining([
        { kind: 'directory-read-write', path: root },
        { kind: 'local-shell', scopeRoots: [root], commands: [{ command: 'git log origin/main --merges --since="yesterday 00:00"', workingDirectory: root }] }
      ])
    })
    expect(result.report.blockers).not.toContainEqual(expect.objectContaining({ code: 'TARGET_UNCLEAR' }))
    expect(result.authorizationContinuation?.authorizedRoots).toEqual([root])
  })

  it('turns an explicit prompt directory and recorded Shell call into a reviewable permission request', async () => {
    const root = '/project'
    const existingRoot = '/authorized'
    const command = 'git log origin/main --merges --since="yesterday 00:00"'
    const prompt = `Summarize yesterday in ${root}`
    const analysis = {
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'no_target_identified' as const }],
      mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command, workingDirectory: root }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
    }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [existingRoot], outputDir: '/results', taskRevision: 1 }, {
      analyzer: { analyze: vi.fn(async () => analysis) },
      factsProvider: { collect: vi.fn(async (roots) => ({
        roots: [...roots], outputRoot: '/results',
        proposedPathCandidates: [{ path: root, kind: 'directory' as const, isGitRepository: true }],
        gitRepositories: roots.includes(root) ? [root] : [],
        entries: roots.map((directory) => ({ path: directory, relativePath: '', kind: 'directory' as const })),
        coverage: { complete: true, truncated: false, roots: roots.length, visited: roots.length, errors: 0 }, digest: roots.join('|')
      })), inspectPaths: vi.fn(async () => [{ path: root, kind: 'directory' as const, isGitRepository: true }]) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED' }],
      permissionNeeds: expect.arrayContaining([
        { kind: 'directory-read-write', path: root },
        { kind: 'local-shell', scopeRoots: [root], commands: [{ command, workingDirectory: root }] }
      ])
    })
    expect(result.authorizationContinuation?.authorizedRoots).toEqual([existingRoot, root])

    const approved = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [existingRoot, root], outputDir: '/results', taskRevision: 1,
      analysisOverride: result.authorizationContinuation!.analysis
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('approved continuation must reuse the reviewed rehearsal') }) },
      factsProvider: { collect: vi.fn(async (roots) => ({
        roots: [...roots], outputRoot: '/results', proposedPathCandidates: [{ path: root, kind: 'directory' as const, isGitRepository: true }],
        gitRepositories: [root], entries: roots.map((directory) => ({ path: directory, relativePath: '', kind: 'directory' as const })),
        coverage: { complete: true, truncated: false, roots: roots.length, visited: roots.length, errors: 0 }, digest: roots.join('|')
      })), inspectPaths: vi.fn(async () => [{ path: root, kind: 'directory' as const, isGitRepository: true }]) }
    })
    expect(approved.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(approved.requiredPermissions).toEqual([{ tool: 'run_shell', command, workingDirectory: root }])
  })

  it('does not hide a real ambiguity when an output Git repository is explicitly named', async () => {
    const root = '/project'
    const prompt = `总结${root}里的重复报告`
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], outputDir: root, taskRevision: 1 }, {
      analyzer: { analyze: vi.fn(async () => ({
        targets: [],
        clarifications: [{ reference: prompt, reasonCode: 'multiple_matches' as const, candidates: [`${root}/a/report.md`, `${root}/b/report.md`] }],
        mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: 'git status --short', workingDirectory: root }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
      })) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [root], entries: [
          { path: root, relativePath: '', kind: 'directory' as const },
          { path: `${root}/a/report.md`, relativePath: 'a/report.md', kind: 'file' as const },
          { path: `${root}/b/report.md`, relativePath: 'b/report.md', kind: 'file' as const }
        ], coverage: { complete: true, truncated: false, roots: 1, visited: 3, errors: 0 }, digest: 'ambiguous-output-git-target'
      })) }
    })

    expect(result.report.blockers).toMatchObject([{ code: 'TARGET_AMBIGUOUS', reasonCode: 'multiple_matches' }])
    expect(result.authorizationContinuation).toBeUndefined()
  })

  it('does not continue to permission review when the initial scope request also has unresolved target blockers', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容'
    const analysis = {
      targets: [],
      clarifications: [
        { reference: prompt, reasonCode: 'target_missing' as const },
        { reference: prompt, reasonCode: 'git_repository_not_found' as const },
        { reference: prompt, reasonCode: 'missing_location' as const }
      ],
      mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
    }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/project', taskRevision: 1 }, {
      analyzer: { analyze: vi.fn(async () => analysis) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [], outputRoot: '/project', outputRootIsGitRepository: false, gitRepositories: [], entries: [],
        coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'project-not-found'
      })) }
    })

    expect(result.report).toMatchObject({ status: 'blocked', blockers: [
      { code: 'TARGET_NOT_FOUND', reasonCode: 'git_repository_not_found', reference: prompt }
    ] })
    expect(result.authorizationContinuation).toBeUndefined()
  })

  it('continues approved output-root permissions with fresh host facts and reuses the mock analysis', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('model must not be called again') }) }
    const analysisOverride = {
      targets: [{ kind: 'exact' as const, path: '/project', targetType: 'directory' as const }],
      requiredPermissions: [{ tool: 'run_shell' as const, command: 'git log --oneline -5', workingDirectory: '/project' }],
      mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: '/project' }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
    }
    const result = await runTaskPreflight({
      prompt: '总结本机 Git 历史', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/project'], outputDir: '/project',
      taskRevision: 1, analysisOverride
    }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({
        roots: ['/project'], outputRoot: '/project', outputRootIsGitRepository: true, gitRepositories: ['/project'],
        entries: [{ path: '/project', relativePath: '', kind: 'directory' as const }],
        coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'approved-project-facts'
      })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, bindings: [{ kind: 'exact', path: '/project' }], factsDigest: 'approved-project-facts' })
    expect(result.requiredPermissions).toEqual(analysisOverride.requiredPermissions)
    expect(analyzer.analyze).not.toHaveBeenCalled()
  })

  it('clears a stale missing-Git clarification after the user approves the verified output repository for reading', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    const root = '/project'
    const result = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], outputDir: root, taskRevision: 2,
      analysisOverride: {
        targets: [],
        clarifications: [
          { reference: prompt, reasonCode: 'target_missing' },
          { reference: prompt, reasonCode: 'output_root_not_read_authorized' },
          { reference: prompt, reasonCode: 'missing_location' },
          { reference: prompt, reasonCode: 'no_target_identified' }
        ],
        mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated', resultKind: 'synthetic' }]
      }
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('the confirmation recheck must reuse the reviewed analysis') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [root],
        entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'approved-output-repo-facts'
      })) }
    })

    expect(result.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(result.requiredPermissions).toEqual([{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: root }])
  })

  it('does not infer a Shell read scope from the write-only result directory', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      requiredPermissions: [{ tool: 'run_shell', command: 'wrong command', workingDirectory: '/wrong' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'no-authorized-roots' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'TOOL_PERMISSION_SCOPE_UNVERIFIED',
      field: 'workDirs'
    })])
    expect(result.requiredPermissions).toBeUndefined()
    expect(result.report.permissionNeeds).toBeUndefined()
  })

  it('does not claim a tool permission list exists when the model gives no concrete tool call', async () => {
    const prompt = '总结本机项目的近期改动'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'capability_not_authorized' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'no-authorized-roots' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({ code: 'TOOL_PERMISSION_DETAILS_MISSING', messageKey: 'butler.preflight.tool_permission_details_missing', reference: prompt })])
  })

  it('reports an unverified Shell working directory when tool calls exist but omit their scope', async () => {
    const prompt = '总结昨天合并进 main 的提交'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [{ reference: prompt, reasonCode: 'capability_not_authorized' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'no-authorized-roots' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'TOOL_PERMISSION_SCOPE_UNVERIFIED',
      messageKey: 'butler.preflight.tool_permission_scope_unverified',
      field: 'workDirs'
    })])
  })

  it('returns a Shell permission requirement for a Git history task without treating it as already authorized', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'wrong command', workingDirectory: '/wrong' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', timeout: 60, workingDirectory: '/workspace' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
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
    const prompt = '总结昨天合并进 main 的提交'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated', resultKind: 'synthetic' }],
      clarifications: [{ reference: prompt, reasonCode: 'capability_not_authorized' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: ['/workspace'], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'git-facts' })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed', blockers: [] }, requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }] })
  })

  it('supports explicitly scoped grep and per-script hash review requirements', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [],
      mockTrace: [
        { kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'release', path: '/workspace/src' }, dispatch: 'simulated', resultKind: 'synthetic' },
        { kind: 'proposed-tool-call', toolName: 'run_script', input: { code: 'print(1)' }, dispatch: 'simulated', resultKind: 'synthetic' }
      ]
    } as never)) }
    const result = await runTaskPreflight({ prompt: '搜索并整理代码', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 3 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const },
        { path: '/workspace/src', relativePath: 'src', kind: 'directory' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 2, errors: 0 }, digest: 'facts' })) }
    })

    expect(result).toMatchObject({ report: { status: 'passed' }, requiredPermissions: [
      { tool: 'grep', scopeRoots: ['/workspace/src'] },
      { tool: 'run_script', scopeRoots: ['/workspace'] }
    ] })
  })

  it('derives an explicitly requested grep directory outside current host facts for authorization', async () => {
    const prompt = '查看 /outside/report.csv 中的内容'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'grep', scopeRoots: ['/wrong'] }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'x', path: '/outside/report.csv' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })),
      inspectPaths: vi.fn(async (paths) => paths.map((candidate) => ({
        path: candidate,
        kind: candidate === '/outside' || candidate === '/workspace' ? 'directory' as const : 'file' as const,
        isGitRepository: false
      }))) }
    })

    expect(result).toMatchObject({
      report: { status: 'blocked', blockers: [{ code: 'TOOL_PERMISSION_REQUIRED' }] },
      requiredPermissions: [{ tool: 'grep', scopeRoots: ['/outside'] }],
      authorizationContinuation: { authorizedRoots: ['/outside', '/workspace'] }
    })
  })

  it('fails closed when a requested Shell permission has no user-selected directory scope', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'output', path: 'summary.txt', expectedType: 'file' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git push --force', workingDirectory: '/wrong' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt: '查询 Git 并生成摘要', scheduleSummary: 'once', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-only' })) }
    })

    expect(result.report).toMatchObject({ status: 'blocked', blockers: [{ code: 'TOOL_PERMISSION_SCOPE_UNVERIFIED', field: 'workDirs' }] })
    expect(result.bindings).toEqual([])
  })

  it('offers concrete new directory scopes for explicit authorization instead of trapping the wizard on step two', async () => {
    const permissionRoot = '/workspace/project'
    const analysis = {
      targets: [{ kind: 'output' as const, path: 'summary.md', expectedType: 'file' as const }],
      requiredPermissions: [],
      mockTrace: [
        { kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const },
        { kind: 'proposed-tool-call' as const, toolName: 'grep', input: { pattern: 'summary', path: `${permissionRoot}/report.csv` }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }
      ]
    }
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => analysis) }
    const result = await runTaskPreflight({ prompt: `Summarize the repository history in ${permissionRoot}`, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1 }, {
      analyzer,
      factsProvider: {
        collect: vi.fn(async () => ({ roots: [], outputRoot: '/results', gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-only' })),
        inspectPaths: vi.fn(async (paths) => paths.map((candidate) => ({
          path: candidate,
          kind: candidate === permissionRoot ? 'directory' as const : 'file' as const,
          isGitRepository: false
        })))
      }
    })

    expect(result).toMatchObject({
      report: { status: 'blocked', blockers: [{ code: 'TOOL_PERMISSION_REQUIRED' }], permissionNeeds: expect.arrayContaining([
        { kind: 'directory-read-write', path: permissionRoot },
        { kind: 'local-shell', scopeRoots: [permissionRoot], commands: [{ command: 'git log --oneline -5', workingDirectory: permissionRoot }] },
        { kind: 'grep', scopeRoots: [permissionRoot] }
      ]) },
      authorizationContinuation: { authorizedRoots: [permissionRoot], analysis: { ...analysis, requiredPermissions: [
        { tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: permissionRoot },
        { tool: 'grep', scopeRoots: [permissionRoot] }
      ] } }
    })
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
    vi.stubEnv('SPACEASSISTANT_DEV', '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: 'report.csv', targetType: 'file' }] })) }
    const factsProvider = { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
      { path: '/workspace/a/report.csv', relativePath: 'a/report.csv', kind: 'file' as const },
      { path: '/workspace/b/report.csv', relativePath: 'b/report.csv', kind: 'file' as const }
    ], coverage: { complete: false, truncated: true, roots: 1, visited: 2, errors: 0 }, digest: 'partial' })) }
    const result = await runTaskPreflight({ prompt: 'Read report.csv', scheduleSummary: 'interval', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 0 }, { analyzer, factsProvider })
    expect(result.report).toMatchObject({ status: 'blocked' })
    expect(result.bindings).toEqual([])
    expect(result.report.blockers.map((item) => item.code)).toContain('FACTS_INCOMPLETE')
    expect(warn).toHaveBeenCalledWith('[taskPreflight] incomplete path facts blocked', expect.objectContaining({
      phase: 'initial-preflight',
      reasons: ['basename_needs_complete_scan'],
      targetKinds: ['exact'],
      requirementsInScope: true
    }))
    warn.mockRestore()
    vi.unstubAllEnvs()
  })

  it('preflights a directly verified repository root even when unrelated descendants exceed the scan limit', async () => {
    const root = '/workspace/project'
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: root, targetType: 'directory' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: root }, dispatch: 'simulated', resultKind: 'synthetic' }]
    })) }
    const result = await runTaskPreflight({
      prompt: '总结仓库历史', scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], taskRevision: 1
    }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], gitRepositories: [root], entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'truncated-repository-facts'
      })) }
    })

    expect(result).toMatchObject({
      report: { status: 'passed', blockers: [] },
      bindings: [{ kind: 'exact', path: root, targetType: 'directory', targetReference: { kind: 'path', value: root } }],
      requiredPermissions: [{ tool: 'run_shell', workingDirectory: root }]
    })
  })

  it('accepts truncated directory facts when file tools stay in approved roots and MCP discovery is local', async () => {
    const root = '/workspace/project'
    const prompt = `总结 ${root} 中的 Git 历史并输出摘要`
    const analysis = {
      targets: [
        { kind: 'exact' as const, path: root, targetType: 'directory' as const },
        { kind: 'output' as const, path: 'summary.md', expectedType: 'file' as const }
      ],
      mockTrace: [
        { kind: 'proposed-tool-call' as const, toolName: 'tool_search', input: { query: 'github history' }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const },
        { kind: 'proposed-tool-call' as const, toolName: 'list_directory', input: { path: root }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const },
        { kind: 'proposed-tool-call' as const, toolName: 'read_file', input: { path: `${root}/README.md` }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const },
        { kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: root }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }
      ]
    }
    const result = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], outputDir: '/results', taskRevision: 1,
      analysisOverride: analysis
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('final confirmation must reuse the rehearsal') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], outputRoot: '/results', gitRepositories: [root], entries: [
          { path: root, relativePath: '', kind: 'directory' as const },
          { path: `${root}/README.md`, relativePath: 'README.md', kind: 'file' as const }
        ], coverage: { complete: false, truncated: true, roots: 1, visited: 2, errors: 0 }, digest: 'truncated-known-file-tools'
      })) }
    })

    expect(result.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(result.requiredPermissions).toEqual([{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: root }])
  })

  it('requests a named external directory for list_directory and accepts local toolkit discovery on final recheck', async () => {
    const existingRoot = '/authorized'
    const requestedRoot = '/Users/space/Documents/Develop/SpaceAssistant'
    const prompt = `总结 ${requestedRoot} 项目中的 Git 历史`
    const analysis = {
      targets: [{ kind: 'exact' as const, path: requestedRoot, targetType: 'directory' as const }],
      mockTrace: [
        { kind: 'proposed-tool-call' as const, toolName: 'toolkit.find', input: { query: '本机 Git 仓库信息' }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const },
        { kind: 'proposed-tool-call' as const, toolName: 'list_directory', input: { path: requestedRoot }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }
      ]
    }
    const inspectPaths = vi.fn(async (paths: readonly string[]) => paths.map((candidate) => ({
      path: candidate, kind: 'directory' as const, isGitRepository: candidate === requestedRoot
    })))
    const factsProvider = {
      collect: vi.fn(async (roots: readonly string[]) => ({
        roots: [...roots], outputRoot: '/results',
        gitRepositories: roots.includes(requestedRoot) ? [requestedRoot] : [],
        entries: roots.map((directory) => ({ path: directory, relativePath: '', kind: 'directory' as const })),
        coverage: roots.includes(requestedRoot)
          ? { complete: false, truncated: true, roots: roots.length, visited: 173, errors: 0 }
          : { complete: true, truncated: false, roots: roots.length, visited: roots.length, errors: 0 },
        digest: roots.join('|')
      })),
      inspectPaths
    }
    const initial = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [existingRoot], outputDir: '/results', taskRevision: 1
    }, {
      analyzer: { analyze: vi.fn(async () => analysis) },
      factsProvider
    })

    expect(initial.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_REQUIRED' }],
      permissionNeeds: expect.arrayContaining([{ kind: 'directory-read-write', path: requestedRoot }])
    })
    expect(initial.authorizationContinuation?.authorizedRoots).toEqual([requestedRoot, existingRoot].sort())
    expect(inspectPaths).toHaveBeenCalledWith([requestedRoot])

    const finalCheck = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [existingRoot, requestedRoot], outputDir: '/results',
      taskRevision: 1, analysisOverride: initial.authorizationContinuation!.analysis
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('final confirmation must reuse the reviewed rehearsal') }) },
      factsProvider
    })

    expect(finalCheck.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(finalCheck.bindings).toMatchObject([{ kind: 'exact', path: requestedRoot, targetType: 'directory' }])
  })

  it('requests authorization from a host-verified explicit target even when no file tool call was recorded', async () => {
    const requestedRoot = '/Users/space/Documents/Develop/SpaceAssistant'
    const prompt = `总结 ${requestedRoot} 项目中的 Git 历史`
    const analysis = { targets: [{ kind: 'exact' as const, path: requestedRoot, targetType: 'directory' as const }], mockTrace: [] }
    const result = await runTaskPreflight({
      prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [], outputDir: '/results', taskRevision: 1
    }, {
      analyzer: { analyze: vi.fn(async () => analysis) },
      factsProvider: {
        collect: vi.fn(async (roots: readonly string[]) => ({
          roots: [...roots], outputRoot: '/results', gitRepositories: [],
          entries: roots.map((directory) => ({ path: directory, relativePath: '', kind: 'directory' as const })),
          coverage: { complete: true, truncated: false, roots: roots.length, visited: roots.length, errors: 0 }, digest: roots.join('|')
        })),
        inspectPaths: vi.fn(async (paths: readonly string[]) => paths.map((candidate) => ({
          path: candidate, kind: 'directory' as const, isGitRepository: candidate === requestedRoot
        })))
      }
    })

    expect(result).toMatchObject({
      report: {
        status: 'blocked',
        blockers: [{ code: 'TOOL_PERMISSION_REQUIRED' }],
        permissionNeeds: expect.arrayContaining([{ kind: 'directory-read-write', path: requestedRoot }])
      },
      authorizationContinuation: { authorizedRoots: [requestedRoot] }
    })
  })

  it('rejects tools without a task-level authorization binding even when path facts are complete', async () => {
    const root = '/workspace'
    const result = await runTaskPreflight({
      prompt: '查询本机时间', scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], taskRevision: 1
    }, {
      analyzer: { analyze: vi.fn(async () => ({
        targets: [{ kind: 'exact' as const, path: root, targetType: 'directory' as const }],
        mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'toolkit.call', input: { id: 'env.time', params: {} }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
      })) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], gitRepositories: [], entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'complete-facts'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_UNSUPPORTED', messageKey: 'butler.preflight.tool_permission_unsupported' }]
    })
  })

  it('keeps truncated facts blocked for file-tool paths outside approved roots', async () => {
    const root = '/workspace/project'
    const result = await runTaskPreflight({
      prompt: `总结 ${root} 中的 Git 历史`, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], taskRevision: 1,
      analysisOverride: {
        targets: [{ kind: 'exact', path: root, targetType: 'directory' }],
        mockTrace: [
          { kind: 'proposed-tool-call', toolName: 'read_file', input: { path: '/private/credentials.txt' }, dispatch: 'simulated', resultKind: 'synthetic' },
          { kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: root }, dispatch: 'simulated', resultKind: 'synthetic' }
        ]
      }
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('final confirmation must reuse the rehearsal') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], gitRepositories: [root], entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'truncated-out-of-scope-file-tool'
      })) }
    })

    expect(result.report).toMatchObject({ status: 'blocked', blockers: [{ code: 'TOOL_PERMISSION_SCOPE_UNVERIFIED' }] })
  })

  it('identifies an unsupported trace tool even when directory facts are truncated', async () => {
    const root = '/workspace/project'
    const result = await runTaskPreflight({
      prompt: `总结 ${root} 中的 Git 历史`, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], taskRevision: 1,
      analysisOverride: {
        targets: [{ kind: 'exact', path: root, targetType: 'directory' }],
        mockTrace: [
          { kind: 'proposed-tool-call', toolName: 'browser', input: { action: 'navigate', url: 'https://example.com' }, dispatch: 'simulated', resultKind: 'synthetic' },
          { kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5', workingDirectory: root }, dispatch: 'simulated', resultKind: 'synthetic' }
        ]
      }
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('final confirmation must reuse the rehearsal') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], gitRepositories: [root], entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'truncated-unmapped-tool'
      })) }
    })

    expect(result.report).toMatchObject({
      status: 'blocked',
      blockers: [{ code: 'TOOL_PERMISSION_UNSUPPORTED', messageKey: 'butler.preflight.tool_permission_unsupported' }]
    })
  })

  it('rechecks a confirmed Shell requirement when the task has no filesystem target to discover', async () => {
    const root = '/workspace/project'
    const analysisOverride = {
      targets: [],
      clarifications: [],
      mockTrace: [{
        kind: 'proposed-tool-call' as const,
        toolName: 'run_shell',
        input: { command: 'git log --oneline -5' },
        dispatch: 'simulated' as const,
        resultKind: 'synthetic' as const
      }]
    }
    const result = await runTaskPreflight({
      prompt: '总结本地 Git 历史', scheduleSummary: 'daily', deliverySummary: 'none',
      roots: [root], outputDir: root, taskRevision: 2, analysisOverride
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('the confirmation recheck must reuse the reviewed analysis') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [root],
        entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'partial-tree-facts'
      })) }
    })

    expect(result).toMatchObject({
      report: { status: 'passed', blockers: [] },
      bindings: [],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: root }],
      factsDigest: 'partial-tree-facts'
    })
  })

  it('rechecks a confirmed Shell permission and output binding when recursive workdir facts are truncated', async () => {
    const root = '/workspace/project'
    const analysisOverride = {
      targets: [{ kind: 'output' as const, path: 'summary.md', expectedType: 'file' as const }],
      clarifications: [],
      mockTrace: [{
        kind: 'proposed-tool-call' as const,
        toolName: 'run_shell',
        input: { command: 'git log --oneline -5', workingDirectory: root },
        dispatch: 'simulated' as const,
        resultKind: 'synthetic' as const
      }]
    }
    const result = await runTaskPreflight({
      prompt: '总结仓库历史并写入结果目录', scheduleSummary: 'daily', deliverySummary: 'none',
      roots: [root], outputDir: root, taskRevision: 2, analysisOverride
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('the confirmation recheck must reuse the reviewed analysis') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], outputRoot: root, outputRootIsGitRepository: true, gitRepositories: [root],
        entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'partial-tree-with-output-target'
      })) }
    })

    expect(result).toMatchObject({
      report: { status: 'passed', blockers: [] },
      bindings: [{ kind: 'output', path: `${root}/summary.md`, outputRoot: root, relativeSuffix: 'summary.md' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: root }],
      factsDigest: 'partial-tree-with-output-target'
    })
  })

  it('rechecks a confirmed Shell permission and directly verified repository target on partial facts', async () => {
    const root = '/workspace/project'
    const analysisOverride = {
      targets: [{ kind: 'exact' as const, path: root, targetType: 'directory' as const }],
      clarifications: [],
      mockTrace: [{
        kind: 'proposed-tool-call' as const,
        toolName: 'run_shell',
        input: { command: 'git log --oneline -5', workingDirectory: root },
        dispatch: 'simulated' as const,
        resultKind: 'synthetic' as const
      }]
    }
    const result = await runTaskPreflight({
      prompt: '总结仓库历史', scheduleSummary: 'daily', deliverySummary: 'none',
      roots: [root], taskRevision: 2, analysisOverride
    }, {
      analyzer: { analyze: vi.fn(async () => { throw new Error('the confirmation recheck must reuse the reviewed analysis') }) },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], gitRepositories: [root], entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'partial-repository-facts'
      })) }
    })

    expect(result).toMatchObject({
      report: { status: 'passed', blockers: [] },
      bindings: [{ kind: 'exact', path: root, targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', workingDirectory: root }]
    })
  })

  it('still blocks confirmation rechecks whose concrete file targets need complete facts', async () => {
    const root = '/workspace/project'
    const result = await runTaskPreflight({
      prompt: '读取 report.csv', scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], taskRevision: 2,
      analysisOverride: { targets: [{ kind: 'exact', path: `${root}/report.csv`, targetType: 'file' }], clarifications: [], mockTrace: [] }
    }, {
      analyzer: { analyze: vi.fn() },
      factsProvider: { collect: vi.fn(async () => ({
        roots: [root], gitRepositories: [], entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
        coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'partial-file-facts'
      })) }
    })

    expect(result.report).toMatchObject({ status: 'blocked', blockers: [{ code: 'FACTS_INCOMPLETE' }] })
    expect(result.bindings).toEqual([])
  })

  it('returns unavailable on model request errors and never exposes tools', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('provider unavailable') }) }
    const result = await runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })
    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_UNAVAILABLE' }] })
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }), expect.any(AbortSignal))
  })

  it('continues to the permission review when the mock budget stops after recording a usable trace', async () => {
    const mockTrace = [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'release', path: '/workspace' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace/release.md', targetType: 'file' }],
      requiredPermissions: [{ tool: 'grep', scopeRoots: ['/workspace'] }],
      clarifications: [], suggestedDirectories: [], mockTrace, mockIncomplete: true, mockIncompleteReason: 'model_round_limit'
    } as never)) }
    const result = await runTaskPreflight({ prompt: 'Find release notes', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [
        { path: '/workspace', relativePath: '', kind: 'directory' as const },
        { path: '/workspace/release.md', relativePath: 'release.md', kind: 'file' as const }
      ], coverage: { complete: true, truncated: false, roots: 1, visited: 2, errors: 0 }, digest: 'facts' })) }
    })

    expect(result).toMatchObject({
      report: { status: 'passed', blockers: [], preflightCoverage: 'partial' },
      bindings: [{ kind: 'exact', path: '/workspace/release.md', taskRevision: 1 }],
      requiredPermissions: [{ tool: 'grep', scopeRoots: ['/workspace'] }], mockTrace
    })
  })

  it('blocks when the mock environment itself cannot produce a trustworthy permission trace', async () => {
    const mockTrace = [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'release', path: '/workspace' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [], requiredPermissions: [], clarifications: [], suggestedDirectories: [], mockTrace, mockIncomplete: true, mockIncompleteReason: 'mock_catalog_incomplete'
    } as never)) }
    const result = await runTaskPreflight({ prompt: 'Find release notes', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result).toMatchObject({
      report: { status: 'blocked', blockers: [{ code: 'MOCK_PREFLIGHT_INCOMPLETE', messageKey: 'butler.preflight.mock_preflight_incomplete' }] },
      bindings: [], mockTrace
    })
  })

  it('explains which unadvertised tool request blocked the mock permission trace', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [],
      clarifications: [],
      suggestedDirectories: [],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'unknown_local_tool', input: {}, dispatch: 'blocked' }],
      mockIncomplete: true,
      mockIncompleteReason: 'mock_adapter_unavailable'
    } as never)) }
    const result = await runTaskPreflight({ prompt: 'Inspect project history', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report.blockers).toEqual([expect.objectContaining({
      code: 'MOCK_TOOL_UNAVAILABLE',
      messageKey: 'butler.preflight.mock_tool_unavailable',
      messageParams: { toolName: 'unknown_local_tool' }
    })])
  })

  it('reports a model response parsing failure separately from a failed model call', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => { throw new Error('PREFLIGHT_MODEL_INVALID_JSON') }) }
    const result = await runTaskPreflight({ prompt: 'read one file', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 1, visited: 0, errors: 0 }, digest: 'facts' })) } })

    expect(result.report).toMatchObject({ status: 'unavailable', blockers: [{ code: 'ANALYZER_INVALID_RESPONSE' }] })
  })

  it('derives the approved Shell command from trace even when the separate summary invents another one', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({
      targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }],
      requiredPermissions: [{ tool: 'run_shell', command: 'git push --force', workingDirectory: '/wrong' }],
      mockTrace: [{ kind: 'proposed-tool-call', toolName: 'run_shell', input: { command: 'git log --oneline -5' }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } as never)) }
    const result = await runTaskPreflight({ prompt: 'inspect Git history', scheduleSummary: 'once', deliverySummary: 'desktop', roots: ['/workspace'], taskRevision: 1 }, { analyzer, factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) } })

    expect(result.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(result.requiredPermissions).toEqual([{ tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' }])
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

  it('ignores malformed model-authored permission fields when no permission call was recorded', async () => {
    const analyzer: TaskPreflightAnalyzer = { analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: '/workspace', targetType: 'directory' }], requiredPermissions: [{ tool: 'run_arbitrary' }] } as never)) }
    const result = await runTaskPreflight({ prompt: 'inspect', scheduleSummary: 'daily', deliverySummary: 'none', roots: ['/workspace'], taskRevision: 1 }, {
      analyzer,
      factsProvider: { collect: vi.fn(async () => ({ roots: ['/workspace'], gitRepositories: [], entries: [{ path: '/workspace', relativePath: '', kind: 'directory' as const }], coverage: { complete: true, truncated: false, roots: 1, visited: 1, errors: 0 }, digest: 'facts' })) }
    })

    expect(result.report).toMatchObject({ status: 'passed', blockers: [] })
    expect(result.requiredPermissions).toEqual([])
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
