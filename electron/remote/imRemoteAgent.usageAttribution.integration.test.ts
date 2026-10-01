import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendMessage, createSession, getDbConnection, openDatabase, prepareTurnAtomically, setConfigValue, type AppDatabase } from '../database'
import { getUsageStepFactsForTurn, getUsageTurnFact } from '../database/operations'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { runImRemoteAgent } from './imRemoteAgent'
import type { WorkDirManager } from '../workDirManager'
import { acceptTurnContext } from '../database/acceptedTurnStorage'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'

vi.mock('../appIpc', () => ({ readAppLocale: () => 'zh-CN' }))

describe('Feishu production entry usage attribution SQLite integration', () => {
  let db: AppDatabase | undefined
  let workDir: string | undefined
  let previousRuntime: ReturnType<typeof getDefaultAgentRuntime> | undefined

  afterEach(async () => {
    db?.close()
    db = undefined
    if (previousRuntime) setDefaultAgentRuntime(previousRuntime)
    previousRuntime = undefined
    if (workDir) await fs.rm(workDir, { recursive: true, force: true })
    workDir = undefined
  })

  it('runs runImRemoteAgent with real invocation assembly and writes linked attribution facts', async () => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'usage-attribution-fixture',
      stream: async function* () {
        yield { type: 'text-delta', text: 'Feishu attribution result' } as const
        yield { type: 'usage', inputTokens: 17, outputTokens: 5 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    db = openDatabase(':memory:')
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-usage-attribution-'))
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const session = createSession(db, { name: 'feishu-usage-attribution', model })
    prepareTurnAtomically(db, {
      user: { id: 'feishu-usage-user', sessionId: session.id, role: 'user', content: 'Check attribution', timestamp: 1, status: 'sent' },
      assistant: { id: 'feishu-usage-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'feishu-usage-turn', requestId: 'feishu-usage-request', sessionId: session.id, assistantMessageId: 'feishu-usage-assistant', state: 'prepared', startToken: 'feishu-usage-start' }
    })
    const acceptedTurn = createAcceptedTurn({
      turnId: 'feishu-usage-turn', requestId: 'feishu-usage-request', sessionId: session.id, lane: 'feishu',
      startToken: 'feishu-usage-start', currentUserMessageId: 'feishu-usage-user', transcriptVersion: 0, config: { lane: 'feishu', model }
    })
    acceptTurnContext(db, acceptedTurn)
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([]))

    const workDirManager: WorkDirManager = {
      listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => workDir!,
      checkDirectoryWritable: () => ({ ok: true })
    } as unknown as WorkDirManager
    const result = await runImRemoteAgent({
      db, sessionId: session.id, requestId: 'feishu-usage-request', turnId: 'feishu-usage-turn', acceptedTurn, workDir, workDirManager,
      userDataDir: path.join(workDir, 'userdata'), getApiKey: async () => 'test-key',
      getBaseUrl: () => 'https://api.anthropic.com', getModel: () => model,
      remoteContext: { source: 'feishu', messageId: 'feishu-message-1', confirmPolicy: 'always' },
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      createProgressAdapter: () => ({ update: vi.fn(), close: vi.fn() } as never),
      buildSystemAppendix: () => 'Feishu attribution integration',
      progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG, progressConfig: {}
    })
    expect(result).toMatchObject({ ok: true, summary: 'Feishu attribution result' })

    const turn = getDbConnection(db).prepare('SELECT turn_id AS turnId FROM turns WHERE request_id = ?').get('feishu-usage-request') as { turnId?: string }
    expect(turn.turnId).toBeTruthy()
    const steps = getUsageStepFactsForTurn(db, session.id, turn.turnId!)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ sessionId: session.id, turnId: turn.turnId, stepId: 'feishu-usage-request:model:1:attempt:1' })
    expect(steps[0]?.attributionJson).not.toBeNull()
    expect(steps[0]?.estimatorVersion).not.toBeNull()
    const turnFact = getUsageTurnFact(db, turn.turnId!)
    expect(turnFact).toMatchObject({ sessionId: session.id, turnId: turn.turnId })
    expect(turnFact?.toolAttributionJson).not.toBeNull()
    expect(JSON.parse(turnFact!.toolAttributionJson!)).toMatchObject({
      tools: expect.any(Object), toolSource: expect.any(Object), toolResults: expect.any(Object)
    })
  })
})
