import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { editFileExecutor, readFileExecutor, writeFileExecutor } from './builtinExecutors'
import { attachTestReadPermit } from './readPermitTestUtils'
import { probeWritePathFact } from '../confirmation/extractors/writePathFacts'
import { buildWriteExecutionPermit } from '../confirmation/writeExecutionPermit'
import * as readPathFacts from '../confirmation/extractors/readPathFacts'

function makeCtx(workDir: string, cache: FileStateCache): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-test',
    toolUseId: 'tool-test',
    sessionId: 'session-test',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

async function executePermittedRead(input: Record<string, unknown>, ctx: ToolExecutionContext) {
  await attachTestReadPermit('read_file', input, ctx)
  return readFileExecutor.execute(input, ctx)
}

describe('read_file 重复读取提示（P1-5，agent-context-token-cost-optimization-plan §5.5）', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-reread-hint-')))
    cache = new FileStateCache()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('同会话第二次完整读取且文件未变化 → 返回提示而非重发全文', async () => {
    const rel = 'doc.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'stable content', 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const first = await executePermittedRead({ path: rel }, ctx)
    expect(first.success).toBe(true)
    expect((first.data as { content?: string }).content).toBe('stable content')

    const second = await executePermittedRead({ path: rel }, ctx)
    expect(second.success).toBe(true)
    const data = second.data as { content?: string; unchangedSinceLastRead?: boolean; note?: string; path?: string }
    expect(data.unchangedSinceLastRead).toBe(true)
    expect(data.content).toBe('')
    expect(data.path).toBe(rel)
    expect(data.note).toContain('offset/limit')
  })

  it('文件被修改后重复读取 → 正常返回全文（提示不误触发）', async () => {
    const rel = 'changed.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'version one', 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    await executePermittedRead({ path: rel }, ctx)

    await fs.writeFile(abs, 'version two with different content', 'utf8')
    const second = await executePermittedRead({ path: rel }, ctx)
    expect(second.success).toBe(true)
    const data = second.data as { content?: string; unchangedSinceLastRead?: boolean }
    expect(data.unchangedSinceLastRead).toBeUndefined()
    expect(data.content).toBe('version two with different content')
  })

  it('带 offset/limit 的重复读取不受提示影响，正常返回内容', async () => {
    const rel = 'ranged.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, ['line one', 'line two', 'line three'].join('\n'), 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    await executePermittedRead({ path: rel }, ctx)

    const ranged = await executePermittedRead({ path: rel, offset: 0, limit: 10 }, ctx)
    expect(ranged.success).toBe(true)
    const data = ranged.data as { content?: string; unchangedSinceLastRead?: boolean }
    expect(data.unchangedSinceLastRead).toBeUndefined()
    expect(data.content).toContain('line one')
  })

  it('评审 P1-1a：mtime 不变但内容变化（size 不同）→ 第二次读取返回新内容，不命中提示', async () => {
    const rel = 'covert-edit.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'original content v1', 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    const first = await executePermittedRead({ path: rel }, ctx)
    expect(first.success).toBe(true)

    // 模拟 FAT32 2s 精度 / 同步软件保留时间戳：内容变化但 mtime 回拨到读取时记录的同一值。
    // utimes 的 Date 只到整毫秒，先统一到整毫秒刻度再驱动，确保 mtime 精确一致。
    const recorded = cache.get(abs)!
    const wholeMs = new Date(Math.ceil(recorded.mtime)).getTime()
    await fs.utimes(abs, new Date(wholeMs), new Date(wholeMs))
    cache.set(abs, { ...recorded, mtime: wholeMs })

    await fs.writeFile(abs, 'original content v1 EXTENDED to a different size', 'utf8')
    await fs.utimes(abs, new Date(wholeMs), new Date(wholeMs))

    const second = await executePermittedRead({ path: rel }, ctx)
    expect(second.success).toBe(true)
    const data = second.data as { content?: string; unchangedSinceLastRead?: boolean }
    expect(data.unchangedSinceLastRead).toBeUndefined()
    expect(data.content).toContain('EXTENDED')
  })

  it('评审 P1-1b：同 size 同 mtime 的隐蔽改动 → edit 护栏报错时失效缓存，重读可自愈', async () => {
    const rel = 'same-size.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'aaaaaaaaaa', 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    const first = await executePermittedRead({ path: rel }, ctx)
    expect(first.success).toBe(true)

    // 同长度替换 + mtime 回拨（整毫秒刻度，保证恢复精确一致）：mtime 与 size 双重校验都无法察觉
    const recorded = cache.get(abs)!
    const wholeMs = new Date(Math.ceil(recorded.mtime)).getTime()
    await fs.utimes(abs, new Date(wholeMs), new Date(wholeMs))
    cache.set(abs, { ...recorded, mtime: wholeMs })

    await fs.writeFile(abs, 'bbbbbbbbbb', 'utf8')
    await fs.utimes(abs, new Date(wholeMs), new Date(wholeMs))

    // edit 护栏应报「外部修改」（内容比对失败），且报错时缓存被失效
    const edit = await editFileExecutor.execute({ path: rel, old_string: 'aaaaaaaaaa', new_string: 'EDITED' }, ctx)
    expect(edit.success).toBe(false)
    expect(String(edit.error)).toContain('重新读取')

    // 重读不再命中去重提示（缓存已失效）→ 拿到真实内容 → 可自愈
    const reread = await executePermittedRead({ path: rel }, ctx)
    const data = reread.data as { content?: string; unchangedSinceLastRead?: boolean }
    expect(data.unchangedSinceLastRead).toBeUndefined()
    expect(data.content).toBe('bbbbbbbbbb')

    // 按新内容编辑成功
    const edit2 = await editFileExecutor.execute({ path: rel, old_string: 'bbbbbbbbbb', new_string: 'EDITED' }, ctx)
    expect(edit2.success).toBe(true)
  })

  it('重复读取提示后 edit_file 护栏不受影响（缓存保持完整快照）', async () => {
    const rel = 'editable.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'alpha beta', 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    await executePermittedRead({ path: rel }, ctx)
    await executePermittedRead({ path: rel }, ctx)

    const edit = await editFileExecutor.execute({ path: rel, old_string: 'alpha', new_string: 'ALPHA' }, ctx)
    expect(edit.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('ALPHA beta')
  })
})

describe('edit/write fileStateCache', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    // macOS 上 os.tmpdir() 是 /private/var 的符号链接，realpath 化以匹配 resolveSafePathReal 的 cache key
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-file-state-')))
    cache = new FileStateCache()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('allows consecutive edits on the same file without re-read', async () => {
    const rel = 'sample.txt'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'alpha beta gamma', 'utf8')

    const ctx = makeCtx(tmpDir, cache)
    const read = await executePermittedRead({ path: rel }, ctx)
    expect(read.success).toBe(true)

    const edit1 = await editFileExecutor.execute(
      { path: rel, old_string: 'alpha', new_string: 'ALPHA' },
      ctx
    )
    expect(edit1.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('ALPHA beta gamma')
    expect(cache.hasBeenRead(abs)).toBe(true)

    const edit2 = await editFileExecutor.execute(
      { path: rel, old_string: 'beta', new_string: 'BETA' },
      ctx
    )
    expect(edit2.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('ALPHA BETA gamma')
  })

  it('allows edit after write_file without re-read', async () => {
    const rel = 'new.txt'
    const abs = path.join(tmpDir, rel)
    const ctx = makeCtx(tmpDir, cache)

    const write = await writeFileExecutor.execute({ path: rel, content: 'hello world' }, ctx)
    expect(write.success).toBe(true)
    expect(cache.hasBeenRead(abs)).toBe(true)

    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'world', new_string: 'SpaceAssistant' },
      ctx
    )
    expect(edit.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('hello SpaceAssistant')
  })

  it('allows overwrite write after read, then edit without re-read', async () => {
    const rel = 'doc.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'version one', 'utf8')

    const ctx = makeCtx(tmpDir, cache)
    expect((await executePermittedRead({ path: rel }, ctx)).success).toBe(true)

    const write = await writeFileExecutor.execute({ path: rel, content: 'version two' }, ctx)
    expect(write.success).toBe(true)

    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'two', new_string: 'three' },
      ctx
    )
    expect(edit.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('version three')
  })

  it('rejects edit when file was never read in session', async () => {
    const rel = 'unread.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'content', 'utf8')

    const ctx = makeCtx(tmpDir, cache)
    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'content', new_string: 'updated' },
      ctx
    )
    expect(edit.success).toBe(false)
    expect(edit.error).toBe('文件尚未在本会话中通过 read_file 读取，请先读取后再编辑')
  })

  it('rejects edit when path is missing', async () => {
    const ctx = makeCtx(tmpDir, cache)
    const edit = await editFileExecutor.execute(
      { old_string: 'a', new_string: 'b' },
      ctx
    )
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/缺少必填参数 path/)
    expect(edit.error).toMatch(/请勿使用 filePath 或 file_path/)
  })

  it('rejects write when path is missing', async () => {
    const ctx = makeCtx(tmpDir, cache)
    const write = await writeFileExecutor.execute({ content: 'hello' }, ctx)
    expect(write.success).toBe(false)
    expect(write.error).toMatch(/缺少必填参数 path/)
    expect(write.error).toMatch(/请勿使用 filePath 或 file_path/)
  })

  it('desktop write consumes a request-bound permit for an outside target', async () => {
    const workDir = path.join(tmpDir, 'work')
    const outsideDir = path.join(tmpDir, 'outside')
    await fs.mkdir(workDir)
    await fs.mkdir(outsideDir)
    const target = path.join(outsideDir, 'approved.txt')
    const input = { path: target, content: 'approved' }
    const fact = await probeWritePathFact({ rawPath: target, workDir, userDataDir: path.join(tmpDir, '.userdata'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const ctx = makeCtx(workDir, cache)
    ctx.lane = 'desktop'
    ctx.writeExecutionPermit = buildWriteExecutionPermit({ requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'write_file', input, target: fact, decisionRuleId: 'confirmed-write', approval: 'confirmed' })
    const result = await writeFileExecutor.execute(input, ctx)
    expect(result.success).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('approved')
  })

  it.each([
    { lane: 'feishu' as const, existing: false },
    { lane: 'feishu' as const, existing: true },
    { lane: 'wechat' as const, existing: false },
    { lane: 'wechat' as const, existing: true }
  ])('$lane 带有效 permit 仍拒绝工作目录外$existing目标写入', async ({ lane, existing }) => {
    const workDir = path.join(tmpDir, 'work')
    const outsideDir = path.join(tmpDir, 'outside')
    await fs.mkdir(workDir)
    await fs.mkdir(outsideDir)
    const target = path.join(outsideDir, `${lane}-${existing ? 'existing' : 'new'}.txt`)
    if (existing) await fs.writeFile(target, 'original')
    const input = { path: target, content: 'outside write' }
    const fact = await probeWritePathFact({ rawPath: target, workDir, userDataDir: path.join(tmpDir, '.userdata'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const ctx = makeCtx(workDir, cache)
    ctx.lane = lane
    if (existing) {
      const stat = await fs.stat(target)
      cache.set(target, { path: target, content: 'original', mtime: stat.mtimeMs, size: stat.size, readAt: Date.now(), isPartial: false })
    }
    ctx.writeExecutionPermit = buildWriteExecutionPermit({ requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'write_file', input, target: fact, decisionRuleId: 'confirmed-write', approval: 'confirmed' })

    const result = await writeFileExecutor.execute(input, ctx)

    expect(result.success).toBe(false)
    expect(result.diagnostic).toMatchObject({ caseId: 'remote-write-target-outside-workdir', category: 'policy', retryable: false })
    expect(existing ? await fs.readFile(target, 'utf8') : await fs.stat(target).then(() => 'created', () => 'missing')).toBe(existing ? 'original' : 'missing')
  })

  it.each(['feishu', 'wechat'] as const)('%s 带已确认 permit 可写入当前工作目录内的新文件', async (lane) => {
    const workDir = path.join(tmpDir, 'work')
    await fs.mkdir(workDir)
    const target = path.join(workDir, `${lane}-inside.txt`)
    const input = { path: target, content: 'inside write' }
    const fact = await probeWritePathFact({ rawPath: target, workDir, userDataDir: path.join(tmpDir, '.userdata'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const ctx = makeCtx(workDir, cache)
    ctx.lane = lane
    ctx.writeExecutionPermit = buildWriteExecutionPermit({ requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'write_file', input, target: fact, decisionRuleId: 'im-write-ask', approval: 'confirmed' })

    const result = await writeFileExecutor.execute(input, ctx)

    expect(result.success).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('inside write')
  })

  it('desktop write executes from its permit without re-running policy path classification', async () => {
    const target = path.join(tmpDir, 'permit-only.txt')
    const input = { path: 'permit-only.txt', content: 'written from permit' }
    const fact = await probeWritePathFact({ rawPath: input.path, workDir: tmpDir, userDataDir: path.join(tmpDir, '.userdata'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const ctx = makeCtx(tmpDir, cache)
    ctx.lane = 'desktop'
    ctx.writeExecutionPermit = buildWriteExecutionPermit({ requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'write_file', input, target: fact, decisionRuleId: 'workdir-write-allow', approval: 'auto-allow' })
    const classify = vi.spyOn(readPathFacts, 'classifyReadPathZone')

    const result = await writeFileExecutor.execute(input, ctx)

    expect(result.success).toBe(true)
    expect(classify).not.toHaveBeenCalled()
    expect(await fs.readFile(target, 'utf8')).toBe('written from permit')
  })

  it('desktop write refuses an existing target changed after permit issuance', async () => {
    const outsideDir = path.join(tmpDir, 'outside-stale')
    await fs.mkdir(outsideDir)
    const target = path.join(outsideDir, 'approved.txt')
    await fs.writeFile(target, 'approved snapshot')
    const input = { path: target, content: 'replacement' }
    const fact = await probeWritePathFact({ rawPath: target, workDir: tmpDir, userDataDir: path.join(tmpDir, '.userdata'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const ctx = makeCtx(tmpDir, cache)
    ctx.lane = 'desktop'
    ctx.writeExecutionPermit = buildWriteExecutionPermit({ requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'write_file', input, target: fact, decisionRuleId: 'confirmed-write', approval: 'confirmed' })
    await fs.writeFile(target, 'changed after approval')
    const result = await writeFileExecutor.execute(input, ctx)
    expect(result.success).toBe(false)
    expect(result.diagnostic).toMatchObject({ category: 'environment' })
    expect(await fs.readFile(target, 'utf8')).toBe('changed after approval')
  })
})
