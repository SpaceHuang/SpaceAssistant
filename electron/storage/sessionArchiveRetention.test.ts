import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAgentLogger, initAgentLogger, resetAgentLoggerForTests } from '../agentLogger/agentLogger'
import {
  pruneSessionArchives,
  SESSION_ARCHIVE_KEEP_COUNT,
  SESSION_ARCHIVE_PRUNE_GRACE_MS,
  SESSION_ARCHIVE_RETENTION_DAYS
} from './sessionArchiveRetention'

const GRACE_MS = SESSION_ARCHIVE_PRUNE_GRACE_MS
const DAY_MS = 24 * 60 * 60 * 1000
const PAYLOAD_BYTES = 1024

// 固定 now（晚于下方真实形态目录名 48 分钟），保证按年龄推导的目录名时间戳完全确定。
const FIXED_NOW = Date.parse('2026-10-14T00:00:00Z')

let userDataDir = ''
let archiveRoot = ''
let logDir = ''

/** flush 后读取真实日志文件，解析全部 storage.archives.pruned 事件——验证事件真实产生，而非只看目录增删。 */
async function prunedEvents(): Promise<Array<Record<string, unknown>>> {
  await flushAgentLogger()
  const logRoot = path.join(logDir, '.agent', 'logs')
  let fileNames: string[]
  try {
    fileNames = await fsp.readdir(logRoot)
  } catch {
    return [] // 日志目录未被创建 = 没有任何事件落盘
  }
  const events: Array<Record<string, unknown>> = []
  for (const file of fileNames) {
    for (const line of (await fsp.readFile(path.join(logRoot, file), 'utf8')).split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.event === 'storage.archives.pruned') events.push(parsed)
    }
  }
  return events
}

/** 按目录名时间戳年龄构造受管归档（与生产命名一致：ISO 的 :/. 替换为 -，后接 UUID），每份含 1024 字节 db。 */
async function seedArchives(agesMs: number[]): Promise<string[]> {
  await fsp.mkdir(archiveRoot, { recursive: true })
  const names = agesMs.map((ageMs) => `${new Date(FIXED_NOW - ageMs).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  for (const name of names) {
    await fsp.mkdir(path.join(archiveRoot, name), { recursive: true })
    await fsp.writeFile(path.join(archiveRoot, name, 'spaceassistant-data.db'), Buffer.alloc(PAYLOAD_BYTES, 1))
  }
  return names
}

function prune(now: number = FIXED_NOW, protect?: string) {
  return pruneSessionArchives(userDataDir, protect ? { now, protect } : { now })
}

describe('session archive retention', () => {
  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-archive-retention-'))
    archiveRoot = path.join(userDataDir, 'session-archives')
    logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-archive-retention-logs-'))
    // 真实 logger（isPackaged → {workDir}/.agent/logs），事件经完整写入链路落盘。
    initAgentLogger({ getWorkDir: () => logDir, isPackaged: true, mainDirname: logDir })
  })

  afterEach(async () => {
    // 先置空 deps 再删目录：避免挂起的日志写链路撞上已删除路径。
    resetAgentLoggerForTests()
    await fsp.rm(userDataDir, { recursive: true, force: true })
    await fsp.rm(logDir, { recursive: true, force: true })
  })

  it('keeps only the newest archive when several exist, each older than the grace window', async () => {
    // 最新一份的年龄 ≥ 宽限期（归档总是过去创建的），间隔均大于宽限期。
    const names = await seedArchives([GRACE_MS, GRACE_MS * 3, GRACE_MS * 5, GRACE_MS * 7])

    const result = await prune()

    expect(result).toEqual({ removed: [names[1]!, names[2]!, names[3]!], kept: names[0]!, freedBytes: PAYLOAD_BYTES * 3 })
    expect(await fsp.readdir(archiveRoot)).toEqual([names[0]!])
    // 可观测性：删除行为必须经 storage.archives.pruned 事件上报，而非只改磁盘。
    expect(await prunedEvents()).toContainEqual(expect.objectContaining(
      { level: 'info', removedCount: 3, freedBytes: PAYLOAD_BYTES * 3, kept: names[0]! }))
  })

  it('treats the 14-day boundary as keep-on-exact-age and removes beyond it', async () => {
    const boundary = await seedArchives([SESSION_ARCHIVE_RETENTION_DAYS * DAY_MS])
    expect(await prune()).toEqual({ removed: [], kept: boundary[0]!, freedBytes: 0 })

    // 单独构造「仅一份超 14 天归档」：删除后零归档态合法。
    await fsp.rm(path.join(archiveRoot, boundary[0]!), { recursive: true, force: true })
    const beyond = await seedArchives([SESSION_ARCHIVE_RETENTION_DAYS * DAY_MS + 5])
    const result = await prune()
    expect(result.removed).toEqual([beyond[0]!])
    expect(result.kept).toBeNull()
    expect(await fsp.readdir(archiveRoot)).toEqual([])
  })

  it('defers the whole prune while the newest archive is younger than the grace window', async () => {
    const names = await seedArchives([0, GRACE_MS * 3])

    const result = await prune()

    // 可能有压缩在飞行（runSafeDbMaintenance 绕过租约）：本次整体延后，什么都不删。
    expect(result).toEqual({ removed: [], kept: null, freedBytes: 0 })
    expect(await fsp.readdir(archiveRoot)).toEqual([...names].sort())
    expect(await prunedEvents()).toContainEqual(expect.objectContaining({ level: 'info', reason: 'in-flight-grace' }))
  })

  it('skips directories younger than the grace window in the protect form and reports reason grace', async () => {
    const [protect, young, old] = await seedArchives([0, GRACE_MS - 60_000, GRACE_MS + 60_000])

    const result = await prune(FIXED_NOW, path.join(archiveRoot, protect!))

    // protect 保留；次新的年轻目录不删（可能是在飞压缩半成品）；仅旧目录被清。
    expect(result).toEqual({ removed: [old!], kept: protect!, freedBytes: PAYLOAD_BYTES })
    expect(await fsp.readdir(archiveRoot)).toEqual([protect!, young!].sort())
    expect(await prunedEvents()).toContainEqual(expect.objectContaining(
      { level: 'info', removedCount: 1, kept: protect!, reason: 'grace' }))
  })

  it('keeps the protected archive and removes all other managed archives older than the grace window', async () => {
    const [protect, second, oldest] = await seedArchives([0, GRACE_MS + 60_000, GRACE_MS * 2])

    const result = await prune(FIXED_NOW, path.join(archiveRoot, protect!))

    expect(result).toEqual({ removed: [second!, oldest!], kept: protect!, freedBytes: PAYLOAD_BYTES * 2 })
    expect(await fsp.readdir(archiveRoot)).toEqual([protect!])
  })

  it('falls back to the startup form when protect does not match the managed naming pattern', async () => {
    const names = await seedArchives([0, GRACE_MS * 2])

    // protect 不匹配命名模式（legacy-json）：按无 protect 处理，防误删全量。
    const result = await prune(FIXED_NOW, path.join(archiveRoot, 'legacy-json'))

    // 启动形态下最新年轻于宽限期 → 整体延后，两份都保留。
    expect(result).toEqual({ removed: [], kept: null, freedBytes: 0 })
    expect(await fsp.readdir(archiveRoot)).toEqual([...names].sort())
  })

  it('manages only directories matching the exact archive naming pattern', async () => {
    // 一份更新的受管归档作为「保留最新」基准；真实生产形态（含毫秒段 -421Z + 固定 UUID）为待删旧档。
    const [keepName] = await seedArchives([GRACE_MS])
    await fsp.mkdir(archiveRoot, { recursive: true })
    const realName = '2026-10-13T23-11-55-421Z-3809f136-a1b2-3c4d-5e6f-0a1b2c3d4e5f'
    const realDir = path.join(archiveRoot, realName)
    await fsp.mkdir(realDir, { recursive: true })
    await fsp.writeFile(path.join(realDir, 'spaceassistant-data.db'), Buffer.alloc(PAYLOAD_BYTES, 1))
    await fsp.mkdir(path.join(archiveRoot, 'legacy-json'), { recursive: true })
    await fsp.writeFile(path.join(archiveRoot, 'notes.txt'), 'not an archive')
    await fsp.mkdir(path.join(archiveRoot, '2026-10-13T23-11-55Z-shortuuid'), { recursive: true })
    await fsp.mkdir(path.join(archiveRoot, 'backup-old'), { recursive: true })

    const result = await prune()

    // 唯一符合真实形态的旧目录被纳入管理删除；异名目录、文件、legacy-json 一概不触碰。
    expect(result.removed).toEqual([realName])
    expect(result.kept).toBe(keepName!)
    expect((await fsp.readdir(archiveRoot)).sort()).toEqual(
      ['2026-10-13T23-11-55Z-shortuuid', 'backup-old', 'legacy-json', 'notes.txt', keepName!].sort())
  })

  it('is a no-op returning empty state when the archives root does not exist', async () => {
    const result = await prune()
    expect(result).toEqual({ removed: [], kept: null, freedBytes: 0 })
    expect(await prunedEvents()).toEqual([])
  })

  it('keeps a failed newest archive state-blind and removes the older complete archive', async () => {
    const [failedNewest, olderComplete] = await seedArchives([GRACE_MS, GRACE_MS * 3])
    await fsp.writeFile(path.join(archiveRoot, failedNewest!, 'maintenance.json'), JSON.stringify({ status: 'failed' }))

    const result = await prune()

    // 状态盲（N1）：prune 不读 maintenance.json——failed 归档作为最新一份同样保留。
    expect(result).toEqual({ removed: [olderComplete!], kept: failedNewest!, freedBytes: PAYLOAD_BYTES })
    expect(await fsp.readdir(archiveRoot)).toEqual([failedNewest!])
  })

  it('continues with remaining removals and does not throw when one directory delete fails', async () => {
    const [newest, victim, oldest] = await seedArchives([GRACE_MS, GRACE_MS * 3, GRACE_MS * 5])
    const realRm = fsp.rm.bind(fsp)
    const rmSpy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (String(target).endsWith(victim!)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' })
      }
      return realRm(target as Parameters<typeof realRm>[0], options)
    })
    try {
      const result = await prune()

      // 受害目录保留，其余照常清理；函数整体不向上抛。
      expect(result.removed).toEqual([oldest!])
      expect(result.kept).toBe(newest!)
      // freedBytes 只计成功删除的目录：失败的 victim 未释放，不得计入（遥测不虚高）。
      expect(result.freedBytes).toBe(PAYLOAD_BYTES)
      expect(await fsp.readdir(archiveRoot)).toEqual([newest!, victim!].sort())
      expect(await prunedEvents()).toContainEqual(expect.objectContaining(
        { level: 'warn', removedCount: 1, kept: newest!, errorCode: 'EBUSY' }))
    } finally {
      rmSpy.mockRestore()
    }
  })

  it('exposes the retention constants contractually', () => {
    expect(SESSION_ARCHIVE_KEEP_COUNT).toBe(1)
    expect(SESSION_ARCHIVE_RETENTION_DAYS).toBe(14)
  })
})
