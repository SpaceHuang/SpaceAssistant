import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnCommandSafe } from '../spawnUtil'
import { downloadGithubArchive } from './skillGithubArchive'

vi.mock('../spawnUtil', () => ({ spawnCommandSafe: vi.fn() }))

const mockedSpawn = vi.mocked(spawnCommandSafe)

type ProcEvents = {
  data: (chunk: string) => void
  close: (code: number) => void
}

/** 构造 tar 子进程替身：在下一个事件循环轮次按需发出 stdout / close */
function fakeProc(emit: (events: ProcEvents) => void): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess
  const stdout = new EventEmitter()
  Object.assign(proc, { stdout })
  setImmediate(() => {
    emit({
      data: (chunk) => stdout.emit('data', chunk),
      close: (code) => (proc as unknown as EventEmitter).emit('close', code)
    })
  })
  return proc
}

const tmpDirs: string[] = []

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-archive-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  mockedSpawn.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('archive-bytes', { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('downloadGithubArchive', () => {
  it('starts every branch attempt from a clean extract directory', async () => {
    const destDir = mkTmpDir()
    let extractionAttempt = 0

    mockedSpawn.mockImplementation((_bin, args) => {
      const argv = args as string[]
      if (argv[0] === '-tvzf') {
        return { proc: fakeProc(({ data, close }) => { data(''); close(0) }) }
      }
      const extractDir = argv[argv.indexOf('-C') + 1]!
      extractionAttempt += 1
      if (extractionAttempt === 1) {
        // main：解压出部分内容后失败，留下残留目录
        return { proc: fakeProc(({ close }) => {
          fs.mkdirSync(path.join(extractDir, 'tools-main', 'skills', 'alpha'), { recursive: true })
          close(1)
        }) }
      }
      // master：tar 退出码 0 但没有产出与 `${repo}-${ref}` 同名的顶层目录
      return { proc: fakeProc(({ close }) => close(0)) }
    })

    // 修复前：唯一目录回退会把上一轮 main 的残留当成 master 的结果返回
    await expect(downloadGithubArchive('acme', 'tools', 'main', destDir)).rejects.toThrow('解压后的仓库结构异常')
    expect(extractionAttempt).toBe(2)
    expect(fs.existsSync(path.join(destDir, 'extract', 'tools-main'))).toBe(false)
  })

  it('resolves the extracted repository root for the requested ref', async () => {
    const destDir = mkTmpDir()
    mockedSpawn.mockImplementation((_bin, args) => {
      const argv = args as string[]
      if (argv[0] === '-tvzf') {
        return { proc: fakeProc(({ data, close }) => { data(''); close(0) }) }
      }
      const extractDir = argv[argv.indexOf('-C') + 1]!
      return { proc: fakeProc(({ close }) => {
        fs.mkdirSync(path.join(extractDir, 'tools-main', 'skills', 'alpha'), { recursive: true })
        fs.writeFileSync(path.join(extractDir, 'tools-main', 'skills', 'alpha', 'SKILL.md'), 'body\n')
        close(0)
      }) }
    })

    await expect(downloadGithubArchive('acme', 'tools', 'main', destDir)).resolves.toBe(
      path.join(destDir, 'extract', 'tools-main')
    )
  })

  it('stops instead of falling back to the next branch when the caller aborts', async () => {
    const destDir = mkTmpDir()
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn(async () => { throw new Error('This operation was aborted') })
    vi.stubGlobal('fetch', fetchMock)

    await expect(downloadGithubArchive('acme', 'tools', 'main', destDir, undefined, undefined, controller.signal))
      .rejects.toThrow('SKILL_INSTALL_CANCELLED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
