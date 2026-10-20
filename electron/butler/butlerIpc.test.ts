import { afterEach, describe, expect, it, vi } from 'vitest'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { openDatabase, type AppDatabase } from '../database'
import { setConfigValue } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { claimDueSlotAndAdvance, createAutomationTask, getAutomationTask, transitionClaimToRunning, updateAutomationTask } from './taskStore'
import { registerButlerIpcHandlers } from './butlerIpc'
import { saveProfiles } from '../mcp/mcpConfigStore'
import { buildMappedToolDescriptors, cacheTools } from '../mcp/mcpToolRegistry'

const electronMock = vi.hoisted(() => ({
  canceled: false,
  filePaths: [] as string[]
}))
vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: electronMock.canceled, filePaths: electronMock.filePaths })) },
  BrowserWindow: { getFocusedWindow: vi.fn(() => undefined) },
  ipcMain: { handle: vi.fn() }
}))

describe('butler IPC workdir/config fields', () => {
  let db: AppDatabase | undefined
  afterEach(() => { db?.close(); db = undefined })

  function handlers(options: { now?: () => number } = {}) {
    db = openDatabase(':memory:')
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db,
      getWorkDir: () => os.tmpdir(),
      getUserDataPath: () => os.tmpdir(),
      getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'provider-model', reasoningEffort: 'off' as const })),
      ...(options.now ? { now: options.now } : {}),
      createAnalyzer: () => ({ analyze: vi.fn(async () => ({ targets: [{ kind: 'exact', path: os.tmpdir(), targetType: 'directory' }] })) }),
      preflight: vi.fn(async (input) => ({ report: { status: 'passed', blockers: [], suggestedDirectories: [] }, bindings: input.roots.length ? [{ kind: 'exact' as const, path: input.roots[0]!, targetType: 'directory' as const, targetReference: { kind: 'path' as const, value: input.roots[0]! }, rawText: input.prompt, resolverVersion: 2, rootsDigest: 'test', taskRevision: input.taskRevision }] : [] }))
    })
    return map
  }

  async function writeAndConfirm(map: Map<string, (...args: unknown[]) => unknown>, channel: 'butler:create' | 'butler:update', payload: unknown): Promise<unknown> {
    const result = await map.get(channel)!(null, payload) as { ok: boolean; kind?: string; reviewId?: string }
    if (!result.ok && result.kind === 'authorization-review-required' && result.reviewId) {
      return map.get('butler:confirm-write')!(null, { reviewId: result.reviewId })
    }
    return result
  }

  it('directory picker reports cancellation without a path and selected paths are validated', async () => {
    const map = handlers()
    electronMock.canceled = true
    await expect(map.get('butler:choose-workdir')!()).resolves.toEqual({ cancelled: true })
    electronMock.canceled = false
    electronMock.filePaths = [os.tmpdir()]
    await expect(map.get('butler:choose-workdir')!()).resolves.toMatchObject({ cancelled: false, path: await realpath(os.tmpdir()) })
  })

  it('result directory picker validates a writable output root separately', async () => {
    const map = handlers()
    electronMock.canceled = true
    await expect(map.get('butler:choose-outputdir')!()).resolves.toEqual({ cancelled: true })
    electronMock.canceled = false
    electronMock.filePaths = [os.tmpdir()]
    await expect(map.get('butler:choose-outputdir')!()).resolves.toMatchObject({ cancelled: false, path: await realpath(os.tmpdir()) })
  })

  it('defaults reasoning effort to off when the configured default model does not support Thinking', async () => {
    const map = handlers()
    setConfigValue(db!, 'config.models', JSON.stringify([{ id: 'model-1', name: 'provider-model', enabled: true, supportsThinking: false }]))
    setConfigValue(db!, 'config.defaultModel', 'provider-model')
    setConfigValue(db!, 'config.thinkingEffort', 'high')
    setConfigValue(db!, 'config.llmServices', JSON.stringify([{ id: 'service-1', name: 'Service', provider: 'openai', supportedModelIds: ['model-1'] }]))
    setConfigValue(db!, 'config.activeLlmServiceIds', JSON.stringify(['service-1']))
    setConfigValue(db!, 'secrets.llmServiceKeys', JSON.stringify({ 'service-1': 'present' }))
    expect(map.get('butler:get-defaults')!()).toMatchObject({ modelId: 'model-1', modelServiceId: 'service-1', reasoningEffort: 'off' })
    expect(map.get('butler:get-defaults')!()).not.toHaveProperty('workDir')
  })

  it('defaults new scheduled tasks to off even when the global chat effort is medium', async () => {
    const map = handlers()
    setConfigValue(db!, 'config.models', JSON.stringify([{ id: 'model-1', name: 'provider-model', enabled: true, supportsThinking: true }]))
    setConfigValue(db!, 'config.defaultModel', 'provider-model')
    setConfigValue(db!, 'config.thinkingEffort', 'medium')
    setConfigValue(db!, 'config.llmServices', JSON.stringify([{ id: 'service-1', name: 'Service', provider: 'openai', supportedModelIds: ['model-1'] }]))
    setConfigValue(db!, 'config.activeLlmServiceIds', JSON.stringify(['service-1']))
    setConfigValue(db!, 'secrets.llmServiceKeys', JSON.stringify({ 'service-1': 'present' }))

    expect(map.get('butler:get-defaults')!()).toMatchObject({ modelId: 'model-1', modelServiceId: 'service-1', reasoningEffort: 'off' })
  })

  it('legacy single-root update requires an explicit result directory before the first edit', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop' })
    const blocked = await map.get('butler:update')!(null, { id: legacy.id, patch: { workDir: os.tmpdir() } }) as { ok: boolean; error?: string }
    expect(blocked).toMatchObject({ ok: false, kind: 'validation-error', error: '结果输出目录不能为空' })
    expect(getAutomationTask(db!, legacy.id)?.preflightVersion).toBe(0)
    const response = await writeAndConfirm(map, 'butler:update', { id: legacy.id, patch: { workDir: os.tmpdir(), outputDir: os.tmpdir(), outputOrganization: 'hourly' } }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: true })
    expect(getAutomationTask(db!, legacy.id)?.workDirs).toEqual([await realpath(os.tmpdir())])
  })

  it('cannot create without an explicit result output directory', async () => {
    const map = handlers()
    const response = await map.get('butler:create')!(null, {
      name: 'task', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', authorizedDirs: []
    }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: false, kind: 'validation-error', error: '结果输出目录不能为空' })
  })

  it('approves the output Git read and exact Shell command as one permission list, then verifies paths without another model pass', async () => {
    db = openDatabase(':memory:')
    const outputRoot = await realpath(os.tmpdir())
    const requiredPermissions = [{ tool: 'run_shell' as const, command: 'git log --oneline -5', workingDirectory: outputRoot }]
    const mockTrace = [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: requiredPermissions[0]!.command, workingDirectory: outputRoot }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
    const preflight = vi.fn(async (input) => input.analysisOverride
      ? {
          report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] },
          bindings: [], factsDigest: 'approved-facts', requiredPermissions, mockTrace
        }
      : {
          report: {
            status: 'blocked' as const,
            blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required', reasonCode: 'output_root_not_read_authorized' as const, candidates: [outputRoot] }],
            suggestedDirectories: [{ path: outputRoot, purposeKey: 'butler.preflight.output_root_read_candidate_purpose', source: 'git history', validationStatus: 'valid' as const }]
          },
          bindings: [], factsDigest: 'initial-facts', requiredPermissions, mockTrace,
          authorizationContinuation: { authorizedRoots: [outputRoot], analysis: { targets: [], requiredPermissions, mockTrace } }
        })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({ enabled: true, allowedTools: [], deniedTools: [] }) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      validateAuthorizedDirs: vi.fn(async (value) => ({ ok: true as const, authorizedDirs: value as string[] })),
      preflight
    })

    const review = await map.get('butler:create')!(null, {
      name: 'Git 汇总', prompt: '总结本机 Git 历史', schedule: { kind: 'daily', time: '09:00' }, deliveryPref: 'none',
      authorizedDirs: [], outputDir: outputRoot, outputOrganization: 'daily'
    }) as { ok: boolean; kind?: string; reviewId?: string; permissions?: Array<{ kind: string; path?: string; commands?: Array<{ command: string; workingDirectory: string }> }> }

    expect(review).toMatchObject({ ok: false, kind: 'authorization-review-required', permissions: [
      { kind: 'directory-read-write', path: outputRoot },
      { kind: 'result-write', outputDirectory: outputRoot, organization: 'daily' },
      { kind: 'local-shell', scopeRoots: [outputRoot], commands: [{ command: 'git log --oneline -5', workingDirectory: outputRoot }] }
    ] })
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(map.get('butler:confirm-write')).toBeTruthy()

    const saved = await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId }) as { ok: boolean; task?: { authorizedDirs: string[]; accessPermissions?: { authorizationRecord?: { preflightFactsDigest?: string; permissions: unknown[] } } } }
    expect(saved.ok).toBe(true)
    expect(saved.task).toMatchObject({
      authorizedDirs: [outputRoot],
      accessPermissions: { authorizationRecord: { preflightFactsDigest: 'approved-facts', permissions: expect.arrayContaining([
        { kind: 'directory-read-write', path: outputRoot },
        { kind: 'local-shell', scopeRoots: [outputRoot], commands: [{ command: 'git log --oneline -5', workingDirectory: outputRoot }] }
      ]) } }
    })
    expect(preflight).toHaveBeenCalledTimes(2)
    expect(preflight.mock.calls[1]?.[0]).toMatchObject({ roots: [outputRoot], analysisOverride: { requiredPermissions } })
  })

  it('stages newly discovered directory and tool permissions for review, then commits only after host revalidation', async () => {
    db = openDatabase(':memory:')
    const permissionRoot = await realpath(os.tmpdir())
    const outputRoot = await realpath(os.tmpdir())
    const requiredPermissions = [
      { tool: 'run_shell' as const, command: 'git log --oneline -5', workingDirectory: permissionRoot },
      { tool: 'grep' as const, scopeRoots: [permissionRoot] }
    ]
    const analysis = { targets: [{ kind: 'output' as const, path: 'summary.md', expectedType: 'file' as const }], requiredPermissions }
    const preflight = vi.fn(async (input) => input.analysisOverride
      ? { report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] }, bindings: [], factsDigest: 'revalidated-facts', requiredPermissions }
      : { report: { status: 'blocked' as const, blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required' }], suggestedDirectories: [] }, bindings: [], factsDigest: 'initial-facts', requiredPermissions,
          authorizationContinuation: { authorizedRoots: [permissionRoot], analysis } })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      validateAuthorizedDirs: vi.fn(async (value) => ({ ok: true as const, authorizedDirs: value as string[] })),
      preflight
    })

    const review = await map.get('butler:create')!(null, {
      name: 'Git summary', prompt: 'Summarize the repository history', schedule: { kind: 'daily', time: '09:00' }, deliveryPref: 'none',
      authorizedDirs: [], outputDir: outputRoot, outputOrganization: 'daily'
    }) as { ok: boolean; kind?: string; reviewId?: string; permissions?: Array<{ kind: string; path?: string; scopeRoots?: string[] }> }

    expect(review).toMatchObject({ ok: false, kind: 'authorization-review-required', permissions: expect.arrayContaining([
      { kind: 'directory-read-write', path: permissionRoot },
      { kind: 'result-write', outputDirectory: outputRoot, organization: 'daily' },
      expect.objectContaining({ kind: 'local-shell', scopeRoots: [permissionRoot] }),
      { kind: 'grep', scopeRoots: [permissionRoot] }
    ]) })
    const saved = await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId }) as { ok: boolean; task?: { authorizedDirs: string[]; accessPermissions?: { authorizationRecord?: { preflightFactsDigest?: string } } } }
    expect(saved).toMatchObject({ ok: true, task: { authorizedDirs: [permissionRoot], accessPermissions: { authorizationRecord: { preflightFactsDigest: 'revalidated-facts' } } } })
    expect(preflight).toHaveBeenCalledTimes(2)
    expect(preflight.mock.calls[1]?.[0]).toMatchObject({ roots: [permissionRoot], analysisOverride: analysis })
  })

  it('final authorization recheck can return preflight-blocked without persisting a task', async () => {
    db = openDatabase(':memory:')
    const permissionRoot = await realpath(os.tmpdir())
    const outputRoot = await realpath(os.tmpdir())
    const requiredPermissions = [{ tool: 'grep' as const, scopeRoots: [permissionRoot] }]
    const analysis = { targets: [{ kind: 'exact' as const, path: permissionRoot, targetType: 'directory' as const }], requiredPermissions }
    const preflight = vi.fn(async (input) => input.analysisOverride
      ? {
          report: { status: 'blocked' as const, blockers: [{ code: 'TARGET_UNCLEAR', messageKey: 'butler.preflight.target_unclear', reference: 'the requested target' }], suggestedDirectories: [] },
          bindings: [], factsDigest: 'blocked-recheck-facts', requiredPermissions
        }
      : {
          report: { status: 'blocked' as const, blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required' }], suggestedDirectories: [] },
          bindings: [], factsDigest: 'initial-facts', requiredPermissions,
          authorizationContinuation: { authorizedRoots: [permissionRoot], analysis }
        })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      validateAuthorizedDirs: vi.fn(async (value) => ({ ok: true as const, authorizedDirs: value as string[] })),
      preflight
    })

    const review = await map.get('butler:create')!(null, {
      name: 'Blocked after confirmation', prompt: 'Find the correct directory', schedule: { kind: 'daily', time: '09:00' }, deliveryPref: 'none',
      authorizedDirs: [], outputDir: outputRoot, outputOrganization: 'daily'
    }) as { ok: boolean; kind?: string; reviewId?: string }
    expect(review).toMatchObject({ ok: false, kind: 'authorization-review-required' })

    const confirmed = await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId }) as { ok: boolean; kind?: string; report?: { blockers: Array<{ code: string }> } }
    expect(confirmed).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { blockers: [{ code: 'TARGET_UNCLEAR' }] } })
    expect(map.get('butler:list')!()).toEqual([])
    expect(preflight).toHaveBeenCalledTimes(2)
  })

  it('does not expose a permission ticket when the same preflight still has target blockers', async () => {
    db = openDatabase(':memory:')
    const permissionRoot = await realpath(os.tmpdir())
    const outputRoot = await realpath(os.tmpdir())
    const requiredPermissions = [{ tool: 'run_shell' as const, command: 'git log --oneline -5', workingDirectory: permissionRoot }]
    const analysis = { targets: [], requiredPermissions, mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: requiredPermissions[0]!.command }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }] }
    const preflight = vi.fn(async () => ({
      report: { status: 'blocked' as const, blockers: [
        { code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required' },
        { code: 'TARGET_NOT_FOUND', messageKey: 'butler.preflight.target_not_found', reasonCode: 'git_repository_not_found' as const }
      ], suggestedDirectories: [] },
      bindings: [], requiredPermissions, authorizationContinuation: { authorizedRoots: [permissionRoot], analysis }
    }))
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      validateAuthorizedDirs: vi.fn(async (value) => ({ ok: true as const, authorizedDirs: value as string[] })),
      preflight
    })

    const result = await map.get('butler:create')!(null, {
      name: 'Git summary', prompt: 'Summarize Git history', schedule: { kind: 'daily', time: '09:00' }, deliveryPref: 'none',
      authorizedDirs: [], outputDir: outputRoot, outputOrganization: 'daily'
    }) as { ok: boolean; kind?: string; report?: { blockers: Array<{ code: string; reasonCode?: string }> } }

    expect(result).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { blockers: [{ code: 'TARGET_NOT_FOUND', reasonCode: 'git_repository_not_found' }] } })
    expect(map.get('butler:list')!()).toEqual([])
  })

  it('rejects a proposed directory when host canonicalization changes its identity after confirmation', async () => {
    db = openDatabase(':memory:')
    const proposedRoot = '/workspace/linked-project'
    const canonicalTarget = '/workspace/private-project'
    const outputRoot = await realpath(os.tmpdir())
    const requiredPermissions = [{ tool: 'run_shell' as const, command: 'git status --short', workingDirectory: proposedRoot }]
    const analysis = { targets: [], requiredPermissions }
    const preflight = vi.fn(async () => ({
      report: { status: 'blocked' as const, blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required' }], suggestedDirectories: [] },
      bindings: [], requiredPermissions, authorizationContinuation: { authorizedRoots: [proposedRoot], analysis }
    }))
    const validateAuthorizedDirs = vi.fn(async (roots: unknown) => Array.isArray(roots) && roots.includes(proposedRoot)
      ? { ok: true as const, authorizedDirs: [canonicalTarget] }
      : { ok: true as const, authorizedDirs: [] })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      validateAuthorizedDirs,
      preflight
    })

    const review = await map.get('butler:create')!(null, {
      name: 'Git status', prompt: 'Check Git status', schedule: { kind: 'daily', time: '09:00' }, deliveryPref: 'none',
      authorizedDirs: [], outputDir: outputRoot, outputOrganization: 'daily'
    }) as { ok: boolean; kind?: string; reviewId?: string }
    expect(review.kind).toBe('authorization-review-required')

    const denied = await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId }) as { ok: boolean; kind?: string }
    expect(denied).toMatchObject({ ok: false, kind: 'validation-error' })
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(getAutomationTask(db, 'missing')).toBeUndefined()
    expect(map.get('butler:list')!()).toEqual([])
  })

  it('passes the validated task reasoning effort to preflight for create and update', async () => {
    db = openDatabase(':memory:')
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const createAnalyzer = vi.fn(() => ({ analyze: vi.fn(async () => ({ targets: [] })) }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'provider-model', reasoningEffort: 'medium' as const })),
      createAnalyzer,
      preflight: vi.fn(async () => ({ report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] }, bindings: [] }))
    })

    const created = await writeAndConfirm(map, 'butler:create', {
      name: 'reasoning', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'none',
      authorizedDirs: [], outputDir: os.tmpdir(), outputOrganization: 'hourly', modelId: 'm', modelServiceId: 's', reasoningEffort: 'medium'
    }) as { ok: boolean; id?: string }
    expect(created.ok).toBe(true)
    expect(createAnalyzer).toHaveBeenNthCalledWith(1, { modelId: 'm', modelServiceId: 's', reasoningEffort: 'medium' })

    await writeAndConfirm(map, 'butler:update', { id: created.id, patch: { prompt: 'updated report' } })
    expect(createAnalyzer).toHaveBeenNthCalledWith(2, { modelId: 'm', modelServiceId: 's', reasoningEffort: 'medium' })
  })

  it('allows an output-only task and keeps its output root separate from authorized read roots', async () => {
    db = openDatabase(':memory:')
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({ report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] }, bindings: [] }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })

    const response = await writeAndConfirm(map, 'butler:create', {
      name: 'output only', prompt: '检查并生成摘要', schedule: { kind: 'interval', intervalMinutes: 60 }, deliveryPref: 'none',
      authorizedDirs: [], accessPermissions: { directories: [], tools: ['run_shell'] }, outputDir: os.tmpdir(), outputOrganization: 'hourly', modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off'
    }) as { ok: boolean; task?: { authorizedDirs: string[]; accessPermissions?: unknown; outputDir: string | null; outputOrganization: string | null; preflightVersion?: number } }

    expect(response).toMatchObject({ ok: true, task: { authorizedDirs: [], accessPermissions: { directories: [], tools: [], authorizationRecord: { permissions: [expect.objectContaining({ kind: 'result-write' })] } }, outputDir: await realpath(os.tmpdir()), outputOrganization: 'hourly', preflightVersion: 1 } })
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ roots: [], outputDir: await realpath(os.tmpdir()) }), expect.any(Object))
  })

  it('requires explicit user confirmation of the host-built permission list before saving and ignores renderer tool grants', async () => {
    const d = openDatabase(':memory:')
    const permissionRoot = await realpath(os.tmpdir())
    db = d
    const mcpServerId = '11111111-2222-4333-8444-555555555555'
    await saveProfiles(d, [{
      id: mcpServerId, name: 'Issue Tracker', enabled: true, transport: 'streamable-http', timeoutSec: 60,
      auth: { mode: 'none' }, http: { endpoint: 'https://mcp.example.test' }, enabledToolNames: ['search_issues']
    }])
    const mcpTools = buildMappedToolDescriptors(mcpServerId, 'Issue Tracker', [{
      name: 'search_issues', description: 'Search issues by query',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }]).descriptors
    cacheTools(d, mcpServerId, { tools: mcpTools, protocolVersion: '2025-06-18', discoveredAt: '2026-10-19T00:00:00.000Z' })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({
      report: { status: 'passed' as const, blockers: [], suggestedDirectories: [], preflightCoverage: 'partial' as const },
      bindings: [], factsDigest: 'facts-digest', requiredPermissions: [
        { tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: permissionRoot, timeout: 45 },
        { tool: 'grep', scopeRoots: [permissionRoot] },
        { tool: 'run_script', scopeRoots: [permissionRoot] },
        { tool: 'mcp', serverId: mcpServerId, toolName: 'search_issues', purpose: '查找最近更新的问题' }
      ],
      mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'grep', input: { pattern: 'release', path: permissionRoot }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
    }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db: d, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({ enabled: true, allowedTools: [], deniedTools: [] }) as never,
      getShellConfig: () => ({ enabled: true }) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const payload = {
      name: 'Git 汇总', prompt: '总结本机 Git 历史', schedule: { kind: 'daily', time: '09:00' }, deliveryPref: 'none',
      authorizedDirs: [os.tmpdir()], accessPermissions: { directories: [], tools: ['run_shell'] },
      outputDir: os.tmpdir(), outputOrganization: 'daily', enabled: true
    }

    const review = await map.get('butler:create')!(null, payload) as { ok: boolean; kind?: string; reviewId?: string; permissions?: Array<{ kind: string; [key: string]: unknown }> }
    expect(review).toMatchObject({ ok: false, kind: 'authorization-review-required', permissions: expect.arrayContaining([
      expect.objectContaining({ kind: 'directory-read-write', path: await realpath(os.tmpdir()) }),
      expect.objectContaining({ kind: 'result-write', outputDirectory: await realpath(os.tmpdir()), organization: 'daily' }),
      expect.objectContaining({ kind: 'local-shell', scopeRoots: [permissionRoot], commands: [{ command: 'git log --oneline -5', workingDirectory: permissionRoot }] }),
      expect.objectContaining({ kind: 'grep', scopeRoots: [permissionRoot] }),
      expect.objectContaining({ kind: 'run-script', scopeRoots: [permissionRoot], scriptHashBinding: 'per-invocation' }),
      expect.objectContaining({ kind: 'mcp-tool', serverId: mcpServerId, serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues by query',
        purpose: '查找最近更新的问题', parameters: [{ name: 'query', type: 'string', required: true }], descriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/), profileHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]) })
    expect(review.reviewId).toBeTruthy()
    expect(map.get('butler:list')!()).toEqual([])
    expect(preflight).toHaveBeenCalledWith(expect.not.objectContaining({ accessPermissions: expect.anything() }), expect.any(Object))
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.arrayContaining([
      expect.objectContaining({ name: 'run_shell', inputSchema: expect.objectContaining({
        required: expect.arrayContaining(['workingDirectory']),
        properties: expect.objectContaining({ workingDirectory: expect.any(Object) })
      }) }),
      expect.objectContaining({ name: 'grep', inputSchema: expect.objectContaining({ properties: expect.any(Object) }) }),
      expect.objectContaining({ name: mcpTools[0]!.mappedName, inputSchema: expect.objectContaining({ properties: expect.any(Object) }) })
    ]) }), expect.any(Object))

    const committed = await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId, enabled: true }) as { ok: boolean; id?: string; task?: { enabled: boolean; taskRevision?: number; accessPermissions?: { tools: string[]; authorizationRecord?: { actor: string; source: string; permissions: unknown[]; preflightTrace?: unknown[]; taskRevision?: number } } } }
    expect(committed).toMatchObject({ ok: true, task: { enabled: false, accessPermissions: { tools: ['run_shell', 'grep', 'run_script'], authorizationRecord: {
      actor: 'user-confirmation', source: 'task-preflight-confirmation', preflightCoverage: 'partial', permissions: expect.any(Array),
      preflightTrace: [{ kind: 'proposed-tool-call', toolName: 'grep', input: { pattern: 'release', path: permissionRoot }, dispatch: 'simulated', resultKind: 'synthetic' }]
    } } } })
    expect((committed as { task?: { accessPermissions?: { authorizationRecord?: { permissions: unknown[] } } } }).task?.accessPermissions?.authorizationRecord?.permissions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mcp-tool', serverId: mcpServerId, toolName: 'search_issues' })]))
    expect((committed as { task?: { accessPermissions?: { authorizationRecord?: { permissions: Array<{ kind: string; commands?: Array<Record<string, unknown>> }> } } } }).task?.accessPermissions?.authorizationRecord?.permissions
      .find((permission) => permission.kind === 'local-shell')?.commands?.[0]).not.toHaveProperty('timeout')
    expect(await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId })).toMatchObject({ ok: false, kind: 'validation-error' })

    const receiptRevision = committed.task?.accessPermissions?.authorizationRecord?.taskRevision
    const taskRevision = committed.task?.taskRevision
    const enable = await map.get('butler:update')!(null, { id: committed.id, patch: { enabled: true, expectedTaskRevision: taskRevision } }) as { ok: boolean; task?: { enabled: boolean; taskRevision?: number; accessPermissions?: { authorizationRecord?: { taskRevision: number } } } }
    expect(enable).toMatchObject({ ok: true, task: { enabled: true, taskRevision, accessPermissions: { authorizationRecord: { taskRevision: receiptRevision } } } })
    expect(map.get('butler:list')!()).toMatchObject([{ id: committed.id, enabled: true }])
    const disable = await map.get('butler:update')!(null, { id: committed.id, patch: { enabled: false, expectedTaskRevision: taskRevision } }) as { ok: boolean; task?: { enabled: boolean; taskRevision?: number; accessPermissions?: { authorizationRecord?: { taskRevision: number } } } }
    expect(disable).toMatchObject({ ok: true, task: { enabled: false, taskRevision, accessPermissions: { authorizationRecord: { taskRevision: receiptRevision } } } })
    const resume = await map.get('butler:update')!(null, { id: committed.id, patch: { enabled: true, expectedTaskRevision: taskRevision } }) as { ok: boolean; task?: { enabled: boolean; taskRevision?: number; accessPermissions?: { authorizationRecord?: { taskRevision: number } } } }
    expect(resume).toMatchObject({ ok: true, task: { enabled: true, taskRevision, accessPermissions: { authorizationRecord: { taskRevision: receiptRevision } } } })
    expect(preflight).toHaveBeenCalledTimes(1)
  })

  it('keeps the permission review ticket valid for 30 minutes so the full list can be reviewed', async () => {
    let currentTime = 10_000
    const map = handlers({ now: () => currentTime })
    const create = () => map.get('butler:create')!(null, {
      name: 'review window', prompt: 'Generate a report', schedule: { kind: 'daily', time: '09:00' },
      deliveryPref: 'none', authorizedDirs: [], outputDir: os.tmpdir(), outputOrganization: 'direct'
    }) as Promise<{ ok: boolean; kind?: string; reviewId?: string }>

    const firstReview = await create()
    expect(firstReview).toMatchObject({ ok: false, kind: 'authorization-review-required' })
    currentTime += 30 * 60_000 - 1
    await expect(map.get('butler:confirm-write')!(null, { reviewId: firstReview.reviewId })).resolves.toMatchObject({ ok: true })

    const secondReview = await create()
    expect(secondReview).toMatchObject({ ok: false, kind: 'authorization-review-required' })
    currentTime += 30 * 60_000
    await expect(map.get('butler:confirm-write')!(null, { reviewId: secondReview.reviewId })).resolves.toMatchObject({
      ok: false,
      kind: 'validation-error',
      error: '权限确认已过期，请重新预检任务'
    })
  })

  it('ignores renderer-supplied access capability claims and only saves the host-confirmed manifest', async () => {
    const map = handlers()
    const response = await map.get('butler:create')!(null, {
      name: 'invalid permission', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop',
      authorizedDirs: [], accessPermissions: { directories: [], tools: ['run_arbitrary'] }, outputDir: os.tmpdir(), outputOrganization: 'hourly'
    }) as { ok: boolean; kind?: string; reviewId?: string; permissions?: Array<{ kind: string }> }

    expect(response).toMatchObject({ ok: false, kind: 'authorization-review-required', permissions: expect.arrayContaining([expect.objectContaining({ kind: 'result-write' })]) })
    expect(response.permissions?.some((permission) => permission.kind === 'local-shell')).toBe(false)
    const saved = await map.get('butler:confirm-write')!(null, { reviewId: response.reviewId }) as { task?: { accessPermissions?: { tools: string[] } } }
    expect(saved.task?.accessPermissions?.tools).toEqual([])
  })

  it('requires a permission review before enabling a preflighted task without a host authorization receipt', async () => {
    const map = handlers()
    const task = createAutomationTask(db!, {
      name: 'legacy preflight task', prompt: '读取报告', schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'none', workDirs: [os.tmpdir()], outputDir: os.tmpdir(), outputOrganization: 'hourly', enabled: false
    })
    getDbConnection(db!).prepare("UPDATE automation_tasks SET preflight_version=1, target_bindings_json='[]' WHERE id=?").run(task.id)

    const review = await map.get('butler:update')!(null, { id: task.id, patch: { enabled: true, expectedTaskRevision: task.taskRevision ?? 0 } }) as { ok: boolean; kind?: string; reviewId?: string; permissions?: unknown[] }
    expect(review).toMatchObject({ ok: false, kind: 'authorization-review-required', permissions: expect.any(Array) })
    expect(getAutomationTask(db!, task.id)?.enabled).toBe(false)

    const committed = await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId }) as { ok: boolean; task?: { enabled: boolean; accessPermissions?: { authorizationRecord?: unknown } } }
    expect(committed).toMatchObject({ ok: true, task: { enabled: false, accessPermissions: { authorizationRecord: expect.any(Object) } } })
  })

  it('blocks an ambiguous target with a structured report and writes no task', async () => {
    const map = handlers()
    const blockedPreflight = vi.fn(async () => ({ report: { status: 'blocked' as const, blockers: [{ code: 'TARGET_AMBIGUOUS', messageKey: 'butler.preflight.target_ambiguous' }], suggestedDirectories: [] }, bindings: [] }))
    const fresh = openDatabase(':memory:')
    db?.close()
    db = fresh
    const mapBlocked = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => mapBlocked.set(channel, handler) } as never, { db, getWorkDir: () => os.tmpdir(), getUserDataPath: () => os.tmpdir(), getToolsConfig: () => ({}) as never } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'provider-model', reasoningEffort: 'off' as const })),
      preflight: blockedPreflight
    })
    const before = mapBlocked.get('butler:list')!() as unknown[]
    const response = await mapBlocked.get('butler:create')!(null, { name: 'blocked', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], outputDir: os.tmpdir(), outputOrganization: 'hourly', modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'provider-model', reasoningEffort: 'off' })
    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_AMBIGUOUS' }] } })
    expect(mapBlocked.get('butler:list')!()).toEqual(before)
    expect(blockedPreflight).toHaveBeenCalledOnce()
  })

  it('does not save a TARGET_UNCLEAR task before the user clarifies its target', async () => {
    const d = openDatabase(':memory:')
    db = d
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d, getToolsConfig: () => ({}) as never } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight: vi.fn(async () => ({ report: { status: 'blocked' as const, blockers: [{ code: 'TARGET_UNCLEAR', messageKey: 'butler.preflight.target_unclear' }], suggestedDirectories: [] }, bindings: [] }))
    })
    const response = await map.get('butler:create')!(null, { name: '草稿', prompt: '帮我处理一下', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], outputDir: os.tmpdir(), outputOrganization: 'hourly', modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' }) as { ok: boolean; kind?: string; report?: unknown }
    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { blockers: [{ code: 'TARGET_UNCLEAR' }] } })
    expect(map.get('butler:list')!()).toEqual([])
  })

  it('does not stage or save a task when the mock tool exercise is incomplete', async () => {
    const d = openDatabase(':memory:')
    db = d
    const map = new Map<string, (...args: unknown[]) => unknown>()
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, {
      db: d, getToolsConfig: () => ({}) as never
    } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight: vi.fn(async () => ({
        report: { status: 'blocked' as const, blockers: [{ code: 'MOCK_PREFLIGHT_INCOMPLETE', messageKey: 'butler.preflight.mock_preflight_incomplete' }], suggestedDirectories: [] },
        bindings: [], mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'run_shell', input: { command: 'git log', workingDirectory: '/tmp' }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
      }))
    })

    const response = await map.get('butler:create')!(null, {
      name: '预算超限', prompt: '检查历史记录', schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'none', authorizedDirs: ['/tmp'], outputDir: os.tmpdir(), outputOrganization: 'hourly',
      modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off'
    })

    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'MOCK_PREFLIGHT_INCOMPLETE' }] } })
    expect(map.get('butler:list')!()).toEqual([])
  })

  it('keeps an existing task unchanged when update preflight reports TARGET_UNCLEAR', async () => {
    const d = openDatabase(':memory:')
    db = d
    const legacy = createAutomationTask(d, { name: 'unclear update', prompt: 'old prompt', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'none', workDirs: [os.tmpdir()] })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({ report: { status: 'blocked' as const, blockers: [{ code: 'TARGET_UNCLEAR', messageKey: 'butler.preflight.target_unclear' }], suggestedDirectories: [] }, bindings: [] }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d, getToolsConfig: () => ({}) as never } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const before = getAutomationTask(d, legacy.id)

    const response = await map.get('butler:update')!(null, { id: legacy.id, patch: { prompt: 'clarify report', outputDir: os.tmpdir(), outputOrganization: 'daily' } })

    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { blockers: [{ code: 'TARGET_UNCLEAR' }] } })
    expect(getAutomationTask(d, legacy.id)).toEqual(before)
    expect(preflight).toHaveBeenCalledOnce()
  })

  it('commits passed preflight bindings with the created task', async () => {
    const map = handlers()
    setConfigValue(db!, 'config.models', JSON.stringify([{ id: 'model-1', name: 'provider-model', enabled: true }]))
    setConfigValue(db!, 'config.llmServices', JSON.stringify([{ id: 'service-1', name: 'Service', provider: 'openai', supportedModelIds: ['model-1'] }]))
    setConfigValue(db!, 'config.activeLlmServiceIds', JSON.stringify(['service-1']))
    setConfigValue(db!, 'secrets.llmServiceKeys', JSON.stringify({ 'service-1': 'present' }))
    const response = await writeAndConfirm(map, 'butler:create', {
      name: 'preflighted', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'desktop', workDirs: [os.tmpdir()], outputDir: os.tmpdir(), outputOrganization: 'hourly', modelId: 'model-1', modelServiceId: 'service-1',
      modelOverride: 'provider-model', reasoningEffort: 'off'
    }) as { ok: boolean; id?: string; task?: { preflightVersion: number; taskRevision: number; targetBindingsJson?: string | null } }
    expect(response).toMatchObject({ ok: true, task: { preflightVersion: 1, taskRevision: 1 } })
    const bindingPath = await realpath(os.tmpdir())
    expect(JSON.parse(response.task?.targetBindingsJson ?? '[]')).toMatchObject([{ path: bindingPath, kind: 'exact' }])
    const stored = getAutomationTask(db!, response.id!)
    expect(stored?.preflightVersion).toBe(1)
    expect(JSON.parse(stored?.targetBindingsJson ?? '[]')).toMatchObject([{ path: bindingPath, kind: 'exact' }])
  })

  it('does not create or update a task when model preflight is unavailable', async () => {
    const d = openDatabase(':memory:')
    db = d
    const legacy = createAutomationTask(d, { name: 'legacy', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()] })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({ report: { status: 'unavailable' as const, blockers: [{ code: 'MODEL_UNAVAILABLE', messageKey: 'butler.preflight.unavailable' }], suggestedDirectories: [] }, bindings: [] }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d, getToolsConfig: () => ({}) as never } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const before = map.get('butler:list')!()
    const payload = { name: 'new', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], outputDir: os.tmpdir(), outputOrganization: 'hourly', modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' }
    expect(await map.get('butler:create')!(null, payload)).toMatchObject({ ok: false, kind: 'preflight-unavailable', error: 'MODEL_UNAVAILABLE' })
    expect(await map.get('butler:update')!(null, { id: legacy.id, patch: { prompt: 'new.csv', outputDir: os.tmpdir(), outputOrganization: 'hourly' } })).toMatchObject({ ok: false, kind: 'preflight-unavailable' })
    expect(map.get('butler:list')!()).toEqual(before)
    expect(getAutomationTask(d, legacy.id)).toMatchObject({ prompt: 'report.csv', preflightVersion: 0 })
    expect(preflight).toHaveBeenCalledTimes(2)
  })

  it('uses the handler entry time for once schedules and blocks an already due value', async () => {
    const d = openDatabase(':memory:')
    db = d
    const map = new Map<string, (...args: unknown[]) => unknown>()
    const preflight = vi.fn(async () => ({ report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] }, bindings: [] }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d, getToolsConfig: () => ({}) as never } as never, {
      now: () => 50_000,
      validateWorkDirs: vi.fn(async (roots) => ({ ok: true as const, workDirs: roots as string[] })),
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const response = await map.get('butler:create')!(null, { name: 'once', prompt: 'report', schedule: { kind: 'once', at: 50_000 }, deliveryPref: 'desktop', workDirs: ['/workspace'], outputDir: os.tmpdir(), outputOrganization: 'direct', modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' })
    expect(response).toMatchObject({ ok: false, kind: 'preflight-blocked', report: { blockers: [{ code: 'ONCE_AT_NOT_FUTURE' }] } })
    expect(preflight).not.toHaveBeenCalled()
    expect(map.get('butler:list')!()).toEqual([])
  })

  it('does not commit a preflight result when the task revision changes while analysis is pending', async () => {
    const d = openDatabase(':memory:')
    db = d
    const legacy = createAutomationTask(d, { name: 'stale', prompt: 'old', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()] })
    const map = new Map<string, (...args: unknown[]) => unknown>()
    let release!: (result: { report: { status: 'passed'; blockers: []; suggestedDirectories: [] }; bindings: [] }) => void
    const preflight = vi.fn(() => new Promise<{ report: { status: 'passed'; blockers: []; suggestedDirectories: [] }; bindings: [] }>((resolve) => { release = resolve }))
    registerButlerIpcHandlers({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => map.set(channel, handler) } as never, { db: d, getToolsConfig: () => ({}) as never } as never, {
      validateModel: vi.fn(async () => ({ ok: true as const, modelId: 'm', modelServiceId: 's', modelOverride: 'm', reasoningEffort: 'off' as const })),
      preflight
    })
    const pending = map.get('butler:update')!(null, { id: legacy.id, patch: { expectedTaskRevision: legacy.taskRevision, name: 'stale write', outputDir: os.tmpdir(), outputOrganization: 'hourly' } }) as Promise<unknown>
    await vi.waitFor(() => expect(preflight).toHaveBeenCalled())
    updateAutomationTask(d, legacy.id, { prompt: 'concurrent write' })
    release({ report: { status: 'passed', blockers: [], suggestedDirectories: [] }, bindings: [] })
    const review = await pending as { ok: boolean; kind?: string; reviewId?: string }
    expect(review).toMatchObject({ ok: false, kind: 'authorization-review-required' })
    expect(await map.get('butler:confirm-write')!(null, { reviewId: review.reviewId })).toMatchObject({ ok: false, kind: 'validation-error', error: 'task-revision-conflict' })
    expect(getAutomationTask(d, legacy.id)).toMatchObject({ name: 'stale', prompt: 'concurrent write', preflightVersion: 0 })
  })

  it('legacy directory-only edit sets its explicit path while leaving legacy model and effort NULL', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], modelOverride: 'old-provider-name' })
    const response = await writeAndConfirm(map, 'butler:update', { id: legacy.id, patch: { workDir: os.tmpdir(), outputDir: os.tmpdir(), outputOrganization: 'hourly' } }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ workDirs: [await realpath(os.tmpdir())], modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })

  it('returns stable conflicts for schedule edits and deletion while a run is active', async () => {
    const map = handlers()
    const task = createAutomationTask(db!, { name: 'scheduled', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], nextRunAt: 100 })
    const claim = claimDueSlotAndAdvance(db!, { taskId: task.id, slot: 100, nextSlot: 200, clientId: 'ipc-pending-conflict' })
    expect(await writeAndConfirm(map, 'butler:update', { id: task.id, patch: { schedule: { kind: 'daily', time: '10:00' }, outputDir: os.tmpdir(), outputOrganization: 'daily' } })).toMatchObject({ ok: false, kind: 'validation-error', error: 'schedule-pending' })
    expect(await map.get('butler:delete')!(null, { id: task.id })).toEqual({ ok: false, error: 'task-has-active-run' })
    expect(transitionClaimToRunning(db!, claim.runId!, task.id, 100, 0).ok).toBe(true)
    expect(await writeAndConfirm(map, 'butler:update', { id: task.id, patch: { schedule: { kind: 'daily', time: '10:00' }, outputDir: os.tmpdir(), outputOrganization: 'daily' } })).toMatchObject({ ok: true })
  })

  it('updates a task with validated canonical multiple roots', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'report', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()] })
    const child = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(`${os.tmpdir()}/butler-roots-`))
    try {
      const response = await writeAndConfirm(map, 'butler:update', { id: legacy.id, patch: { workDirs: [child, os.tmpdir(), child], outputDir: os.tmpdir(), outputOrganization: 'hourly' } }) as { ok: boolean; error?: string }
      expect(response).toMatchObject({ ok: true })
      expect(getAutomationTask(db!, legacy.id)?.workDirs).toEqual([await realpath(child), await realpath(os.tmpdir())].sort())
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(child, { recursive: true, force: true }))
    }
  })

  it('legacy task fields can be edited without submitting new config and keep NULL compatibility columns', async () => {
    const map = handlers()
    const legacy = createAutomationTask(db!, { name: 'legacy', prompt: 'old prompt', schedule: { kind: 'interval', intervalMinutes: 30 }, deliveryPref: 'desktop', workDirs: [os.tmpdir()], modelOverride: 'old-provider-name' })
    const response = await writeAndConfirm(map, 'butler:update', { id: legacy.id, patch: { name: 'renamed', prompt: 'new prompt', schedule: { kind: 'interval', intervalMinutes: 45 }, outputDir: os.tmpdir(), outputOrganization: 'hourly' } }) as { ok: boolean; error?: string }
    expect(response).toMatchObject({ ok: true })
    expect(getAutomationTask(db!, legacy.id)).toMatchObject({ name: 'renamed', prompt: 'new prompt', schedule: { kind: 'interval', intervalMinutes: 45 }, modelOverride: 'old-provider-name' })
    expect(getAutomationTask(db!, legacy.id)?.workDirs).toEqual([os.tmpdir()])
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('modelServiceId')
    expect(getAutomationTask(db!, legacy.id)).not.toHaveProperty('reasoningEffort')
  })
})
