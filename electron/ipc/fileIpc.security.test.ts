import fs from 'fs'
import fsPromises from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import { openDatabase } from '../database'
import { registerFileIpc } from './fileIpc'

const roots: string[] = []
const dbs: ReturnType<typeof openDatabase>[] = []
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-ipc-security-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function world() {
  const base = tempRoot()
  const workDir = path.join(base, 'work')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(workDir)
  fs.mkdirSync(outside)
  const db = openDatabase(':memory:')
  dbs.push(db)
  const handlers = new Map<string, (...args: never[]) => unknown>()
  registerFileIpc({ handle: (channel: string, fn: unknown) => handlers.set(channel, fn as never) } as unknown as IpcMain,
    { getWorkDir: () => workDir, getUserDataPath: () => base, db } as unknown as AppIpcContext)
  return { workDir, outside, handlers }
}

describe('file IPC destructive operation guards', () => {
  it('does not truncate a same-name file when creating', async () => {
    const { workDir, handlers } = await world()
    fs.writeFileSync(path.join(workDir, 'important.txt'), 'original')
    await expect(handlers.get('file:create-file')!(null as never, 'important.txt' as never)).rejects.toThrow()
    expect(fs.readFileSync(path.join(workDir, 'important.txt'), 'utf8')).toBe('original')
  })

  it('rejects symlinked parent paths for create, delete, rename and move', async () => {
    const { workDir, outside, handlers } = await world()
    fs.symlinkSync(outside, path.join(workDir, 'linked'), 'dir')
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep')
    fs.writeFileSync(path.join(workDir, 'source.txt'), 'source')
    for (const [channel, args] of [
      ['file:create-file', ['linked/new.txt']],
      ['file:create-directory', ['linked/new-dir']],
      ['file:delete', ['linked/victim.txt']],
      ['file:rename', ['linked/victim.txt', 'renamed.txt']],
      ['file:move', ['source.txt', 'linked']]
    ] as const) {
      await expect(handlers.get(channel)!(null as never, ...args as never[])).rejects.toThrow()
    }
    expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('keep')
    expect(fs.readFileSync(path.join(workDir, 'source.txt'), 'utf8')).toBe('source')
    await expect(handlers.get('file:copy')!(null as never, { srcRelPath: 'linked/victim.txt', destRelPath: 'copy.txt' } as never)).rejects.toThrow()
    expect(fs.existsSync(path.join(workDir, 'copy.txt'))).toBe(false)
  })

  it('preserves existing rename and move destinations', async () => {
    const { workDir, handlers } = await world()
    fs.writeFileSync(path.join(workDir, 'source.txt'), 'source')
    fs.writeFileSync(path.join(workDir, 'target.txt'), 'target')
    fs.mkdirSync(path.join(workDir, 'dest'))
    fs.writeFileSync(path.join(workDir, 'dest', 'source.txt'), 'move-target')
    await expect(handlers.get('file:rename')!(null as never, 'source.txt' as never, 'target.txt' as never)).rejects.toThrow()
    await expect(handlers.get('file:move')!(null as never, 'source.txt' as never, 'dest' as never)).rejects.toThrow()
    await expect(handlers.get('file:copy')!(null as never, { srcRelPath: 'source.txt', destRelPath: 'target.txt' } as never)).rejects.toThrow()
    expect(fs.readFileSync(path.join(workDir, 'source.txt'), 'utf8')).toBe('source')
    expect(fs.readFileSync(path.join(workDir, 'target.txt'), 'utf8')).toBe('target')
    expect(fs.readFileSync(path.join(workDir, 'dest', 'source.txt'), 'utf8')).toBe('move-target')
  })

  it('allows only one concurrent rename or move to claim a shared file destination', async () => {
    const { workDir, handlers } = await world()
    const originalLink = fsPromises.link.bind(fsPromises)
    const raceLinks = () => {
      let arrivals = 0
      let release!: () => void
      const barrier = new Promise<void>((resolve) => { release = resolve })
      const spy = vi.spyOn(fsPromises, 'link').mockImplementation(async (source, target) => {
        arrivals += 1
        if (arrivals === 2) release()
        await barrier
        return originalLink(source, target)
      })
      return () => spy.mockRestore()
    }

    fs.writeFileSync(path.join(workDir, 'a.txt'), 'A')
    fs.writeFileSync(path.join(workDir, 'b.txt'), 'B')
    const restoreRenameLinks = raceLinks()
    const renameResults = await Promise.allSettled([
      handlers.get('file:rename')!(null as never, 'a.txt' as never, 'target.txt' as never),
      handlers.get('file:rename')!(null as never, 'b.txt' as never, 'target.txt' as never)
    ])
    restoreRenameLinks()
    expect(renameResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(renameResults.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(['A', 'B']).toContain(fs.readFileSync(path.join(workDir, 'target.txt'), 'utf8'))
    expect([fs.existsSync(path.join(workDir, 'a.txt')), fs.existsSync(path.join(workDir, 'b.txt'))].filter(Boolean)).toHaveLength(1)

    fs.mkdirSync(path.join(workDir, 'left'))
    fs.mkdirSync(path.join(workDir, 'right'))
    fs.mkdirSync(path.join(workDir, 'dest'))
    fs.writeFileSync(path.join(workDir, 'left', 'same.txt'), 'left')
    fs.writeFileSync(path.join(workDir, 'right', 'same.txt'), 'right')
    const restoreMoveLinks = raceLinks()
    const moveResults = await Promise.allSettled([
      handlers.get('file:move')!(null as never, 'left/same.txt' as never, 'dest' as never),
      handlers.get('file:move')!(null as never, 'right/same.txt' as never, 'dest' as never)
    ])
    restoreMoveLinks()
    expect(moveResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(moveResults.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(['left', 'right']).toContain(fs.readFileSync(path.join(workDir, 'dest', 'same.txt'), 'utf8'))
    expect([fs.existsSync(path.join(workDir, 'left', 'same.txt')), fs.existsSync(path.join(workDir, 'right', 'same.txt'))].filter(Boolean)).toHaveLength(1)
  })

  it('preserves an editor atomic-save replacement during rename and move', async () => {
    const { workDir, handlers } = await world()
    const originalLink = fsPromises.link.bind(fsPromises)
    const originalRename = fsPromises.rename.bind(fsPromises)

    async function replaceSourceAfterLink(source: string) {
      const temporary = path.join(path.dirname(source), '.editor-save.tmp')
      await fsPromises.writeFile(temporary, 'new editor contents')
      await originalRename(temporary, source)
    }

    fs.writeFileSync(path.join(workDir, 'rename-source.txt'), 'old contents')
    const renameSpy = vi.spyOn(fsPromises, 'link').mockImplementation(async (source, target) => {
      await originalLink(source, target)
      await replaceSourceAfterLink(source)
    })
    await expect(handlers.get('file:rename')!(null as never, 'rename-source.txt' as never, 'renamed.txt' as never))
      .rejects.toThrow(/源文件在操作期间已更新/)
    renameSpy.mockRestore()
    expect(fs.readFileSync(path.join(workDir, 'rename-source.txt'), 'utf8')).toBe('new editor contents')
    expect(fs.readFileSync(path.join(workDir, 'renamed.txt'), 'utf8')).toBe('old contents')

    fs.mkdirSync(path.join(workDir, 'src'))
    fs.mkdirSync(path.join(workDir, 'dest'))
    fs.writeFileSync(path.join(workDir, 'src', 'move-source.txt'), 'old move contents')
    const moveSpy = vi.spyOn(fsPromises, 'link').mockImplementation(async (source, target) => {
      await originalLink(source, target)
      await replaceSourceAfterLink(source)
    })
    await expect(handlers.get('file:move')!(null as never, 'src/move-source.txt' as never, 'dest' as never))
      .rejects.toThrow(/源文件在操作期间已更新/)
    moveSpy.mockRestore()
    expect(fs.readFileSync(path.join(workDir, 'src', 'move-source.txt'), 'utf8')).toBe('new editor contents')
    expect(fs.readFileSync(path.join(workDir, 'dest', 'move-source.txt'), 'utf8')).toBe('old move contents')
  })

  it('does not unlink a replacement saved immediately before source unlink', async () => {
    const { workDir, handlers } = await world()
    const source = path.join(workDir, 'source.txt')
    const target = path.join(workDir, 'target.txt')
    const originalRename = fsPromises.rename.bind(fsPromises)
    fs.writeFileSync(source, 'old version')
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (input, destination) => {
      if (String(input) === source && String(destination).includes('.sa-move-recovery-')) {
        const temporary = path.join(workDir, 'editor-save.tmp')
        fs.writeFileSync(temporary, 'new user edits')
        fs.renameSync(temporary, source)
      }
      return originalRename(input, destination)
    })
    try {
      await expect(handlers.get('file:rename')!(null as never, 'source.txt' as never, 'target.txt' as never))
        .rejects.toThrow(/源文件在操作期间已更新/)
    } finally {
      renameSpy.mockRestore()
    }
    expect(fs.readFileSync(source, 'utf8')).toBe('new user edits')
    expect(fs.readFileSync(target, 'utf8')).toBe('old version')
    expect(fs.readdirSync(workDir).some((name) => name.startsWith('.sa-move-recovery-'))).toBe(true)
  })

  it('renames and moves ordinary directories while preserving their contents', async () => {
    const { workDir, handlers } = await world()
    fs.mkdirSync(path.join(workDir, 'folder'))
    fs.writeFileSync(path.join(workDir, 'folder', 'keep.txt'), 'keep')
    fs.mkdirSync(path.join(workDir, 'destination'))
    await handlers.get('file:rename')!(null as never, 'folder' as never, 'renamed' as never)
    expect(fs.readFileSync(path.join(workDir, 'renamed', 'keep.txt'), 'utf8')).toBe('keep')
    await handlers.get('file:move')!(null as never, 'renamed' as never, 'destination' as never)
    expect(fs.readFileSync(path.join(workDir, 'destination', 'renamed', 'keep.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(workDir, 'renamed'))).toBe(false)
  })
})
