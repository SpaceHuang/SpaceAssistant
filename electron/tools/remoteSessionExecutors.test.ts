import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, openDatabase } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { switchSessionExecutor } from './remoteSessionExecutors'
import type { ToolExecutionContext } from './types'
import {
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from '../remote/remoteAgentRegistry'
import {
  REMOTE_SESSION_SWITCH_BUSY_CALLER,
  REMOTE_SESSION_SWITCH_DENIED_MESSAGE
} from '../remote/remoteSessionGuardMessages'
import {
  beginLlm,
  beginTool,
  resetRemoteSessionSwitchStateForTests
} from '../remote/remoteSessionSwitchState'

vi.mock('../remote/requestRendererSessionSwitch', () => ({
  requestRendererSessionSwitch: vi.fn().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
}))

vi.mock('../windowRef', () => ({
  getMainWindow: () => ({ webContents: { id: 1, isDestroyed: () => false } })
}))

const feishuCliEvents: Array<{ level: string; event: string; payload: Record<string, unknown> }> = []
vi.mock('../feishu/feishuCliLogger', () => ({
  logFeishuCliEvent: (level: string, event: string, payload: Record<string, unknown>) => {
    feishuCliEvents.push({ level, event, payload })
  },
  logFeishuAuditMirror: () => undefined
}))

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rse-'))
}

describe('switchSessionExecutor', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
    resetRemoteSessionSwitchStateForTests()
    feishuCliEvents.length = 0
    vi.clearAllMocks()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function setup() {
    const dir = tempDir()
    dirs.push(dir)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dir,
      setWorkDir: () => undefined
    })
    return { db, manager, dir }
  }

  function makeCtx(
    db: ReturnType<typeof openDatabase>,
    manager: ReturnType<typeof createWorkDirManager>,
    callerId: string,
    remoteContext: ToolExecutionContext['remoteContext'],
    requestId = 'req-1'
  ) {
    return {
      workDir: manager.getActiveWorkDir(),
      userDataDir: tempDir(),
      requestId,
      toolUseId: 'tu-1',
      sessionId: callerId,
      sendProgress: () => undefined,
      signal: new AbortController().signal,
      fileStateCache: {} as ToolExecutionContext['fileStateCache'],
      toolsConfig: { enabled: true, allowedTools: [], deniedTools: [] },
      appDatabase: db,
      workDirManager: manager,
      remoteContext
    } satisfies ToolExecutionContext
  }

  it('rejects without remoteContext (B2)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const result = await switchSessionExecutor.execute({ session_id: caller.id }, makeCtx(db, manager, caller.id, undefined))
    expect(result.success).toBe(false)
    expect(result.error).toContain('远程会话')
  })

  it('switches to matching feishu session (B1)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const target = createSession(db, {
      name: 'target',
      metadata: { source: 'feishu', feishuChatId: 'chat-1' }
    })
    const auditEntries: unknown[] = []
    const remoteContext = {
      source: 'feishu' as const,
      messageId: 'm1',
      confirmPolicy: 'always' as const,
      chatId: 'chat-1',
      appendSessionSwitchAudit: (entry: unknown) => {
        auditEntries.push(entry)
      }
    }
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, remoteContext)
    )
    expect(result.success).toBe(true)
    expect(remoteContext.sessionId).toBe(target.id)
    const data = result.data as { sessionId: string; desktopSwitched: boolean }
    expect(data.sessionId).toBe(target.id)
    expect(data.desktopSwitched).toBe(true)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0]).toMatchObject({ kind: 'success', targetSessionId: target.id })
    expect(feishuCliEvents.some((e) => e.event === 'feishu.session.switch')).toBe(true)
  })

  it('rejects identity mismatch (B3)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const target = createSession(db, {
      name: 'target',
      metadata: { source: 'feishu', feishuChatId: 'other-chat' }
    })
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, {
        source: 'feishu',
        messageId: 'm1',
        confirmPolicy: 'always',
        chatId: 'chat-1'
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_SESSION_SWITCH_DENIED_MESSAGE)
    expect(feishuCliEvents.some((e) => e.event === 'feishu.session.switch_denied')).toBe(true)
  })

  it('rejects when caller has tool in-flight (B4)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const target = createSession(db, { name: 'target', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    beginTool(caller.id, 'req-1', 'read_file')
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, {
        source: 'feishu',
        messageId: 'm1',
        confirmPolicy: 'always',
        chatId: 'c1'
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_SESSION_SWITCH_BUSY_CALLER)
  })

  it('allows switch when caller only registry-claimed (94e44c4a regression)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const target = createSession(db, { name: 'target', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    tryClaimRemoteSession(caller.id, 4)
    beginLlm(caller.id, 'req-inbound')
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(
        db,
        manager,
        caller.id,
        {
          source: 'feishu',
          messageId: 'm1',
          confirmPolicy: 'always',
          chatId: 'c1'
        },
        'req-inbound'
      )
    )
    expect(result.success).toBe(true)
    releaseRemoteSession(caller.id)
  })

  it('rejects when caller has pending confirm via confirmManager', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const target = createSession(db, { name: 'target', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, {
        source: 'feishu',
        messageId: 'm1',
        confirmPolicy: 'always',
        chatId: 'c1',
        confirmManager: { hasPendingForSession: (id: string) => id === caller.id } as NonNullable<
          ToolExecutionContext['remoteContext']
        >['confirmManager']
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_SESSION_SWITCH_BUSY_CALLER)
  })
})
