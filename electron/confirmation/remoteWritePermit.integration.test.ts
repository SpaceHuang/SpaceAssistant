import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { evaluateToolCallGate } from './toolCallGate'
import { buildWriteExecutionPermit } from './writeExecutionPermit'
import { FileStateCache } from '../fileStateCache'
import { writeFileExecutor } from '../tools/builtinExecutors'
import type { RemoteContext, ToolExecutionContext } from '../tools/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-write-permit-e2e-')))
  roots.push(dir)
  return dir
}

function remoteContext(source: 'feishu' | 'wechat'): RemoteContext {
  return { source, messageId: 'message-1', confirmPolicy: 'im_confirm', requestId: 'request-1' }
}

async function gateWrite(args: {
  lane: 'feishu' | 'wechat'
  workDir: string
  input: Record<string, unknown>
}) {
  return evaluateToolCallGate({
    toolName: 'write_file',
    toolInput: args.input,
    sessionId: 'session-1',
    requestId: 'request-1',
    toolUseId: 'tool-1',
    lane: args.lane,
    workDir: args.workDir,
    userDataDir: path.join(args.workDir, '.userdata'),
    remoteContext: remoteContext(args.lane),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    effectiveRules: DEFAULT_POLICY_RULES,
    lanePackage: 'standard',
    decisionCache: {
      lookup: () => null,
      record: () => undefined,
      clear: () => 0,
      clearAllSession: () => 0,
      expireDormant: () => 0
    },
    shellPrecheck: { touchTrustedCommand: () => undefined },
    audit: { record: () => undefined }
  })
}

function executionContext(args: {
  lane: 'feishu' | 'wechat'
  workDir: string
  input: Record<string, unknown>
  fact: NonNullable<Awaited<ReturnType<typeof gateWrite>>['writePathFact']>
  decisionRuleId: string
}): ToolExecutionContext {
  const cache = new FileStateCache()
  return {
    workDir: args.workDir,
    userDataDir: path.join(args.workDir, '.userdata'),
    requestId: 'request-1',
    toolUseId: 'tool-1',
    sessionId: 'session-1',
    sendProgress: () => undefined,
    signal: AbortSignal.timeout(30_000),
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
    lane: args.lane,
    remoteContext: remoteContext(args.lane),
    writeExecutionPermit: buildWriteExecutionPermit({
      requestId: 'request-1',
      toolUseId: 'tool-1',
      toolName: 'write_file',
      input: args.input,
      target: args.fact,
      decisionRuleId: args.decisionRuleId,
      approval: 'confirmed'
    })
  }
}

describe('远程写入 gate → 确认许可 → executor 范围端到端', () => {
  it.each(['feishu', 'wechat'] as const)('%s 越界新建被 gate 拒绝，即使带结构有效的确认许可 executor 仍拒绝', async (lane) => {
    const root = await tempDir()
    const workDir = path.join(root, 'work')
    const outsideDir = path.join(root, 'outside')
    await fs.mkdir(workDir)
    await fs.mkdir(outsideDir)
    const target = path.join(outsideDir, 'new.txt')
    const input = { path: target, content: 'must stay absent' }
    const gate = await gateWrite({ lane, workDir, input })

    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-write-deny' })
    expect(gate.writePathFact).toBeDefined()
    const ctx = executionContext({ lane, workDir, input, fact: gate.writePathFact!, decisionRuleId: 'im-write-ask' })
    const result = await writeFileExecutor.execute(input, ctx)

    expect(result.success).toBe(false)
    expect(result.diagnostic).toMatchObject({ caseId: 'remote-write-target-outside-workdir', category: 'policy', retryable: false })
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['feishu', 'wechat'] as const)('%s 越界覆盖被 gate 与 executor 拒绝，原文件保持不变', async (lane) => {
    const root = await tempDir()
    const workDir = path.join(root, 'work')
    const outsideDir = path.join(root, 'outside')
    await fs.mkdir(workDir)
    await fs.mkdir(outsideDir)
    const target = path.join(outsideDir, 'existing.txt')
    await fs.writeFile(target, 'original')
    const input = { path: target, content: 'replacement' }
    const gate = await gateWrite({ lane, workDir, input })

    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-write-deny' })
    const ctx = executionContext({ lane, workDir, input, fact: gate.writePathFact!, decisionRuleId: 'im-write-ask' })
    const stat = await fs.stat(target)
    ctx.fileStateCache.set(target, { path: target, content: 'original', mtime: stat.mtimeMs, size: stat.size, readAt: Date.now(), isPartial: false })
    const result = await writeFileExecutor.execute(input, ctx)

    expect(result.success).toBe(false)
    expect(result.diagnostic).toMatchObject({ caseId: 'remote-write-target-outside-workdir', category: 'policy', retryable: false })
    expect(await fs.readFile(target, 'utf8')).toBe('original')
  })

  it.each(['feishu', 'wechat'] as const)('%s 确认后可写入 workDir 内文件', async (lane) => {
    const workDir = path.join(await tempDir(), 'work')
    await fs.mkdir(workDir)
    const target = path.join(workDir, 'inside.txt')
    const input = { path: target, content: 'authorized inside' }
    const gate = await gateWrite({ lane, workDir, input })

    expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'im-write-ask', answerer: 'user' })
    const ctx = executionContext({ lane, workDir, input, fact: gate.writePathFact!, decisionRuleId: gate.decision.ruleId })
    const result = await writeFileExecutor.execute(input, ctx)

    expect(result.success).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('authorized inside')
  })
})
