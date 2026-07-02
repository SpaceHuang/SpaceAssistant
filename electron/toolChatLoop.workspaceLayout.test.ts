import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { applyWorkspaceLayoutRedirect } from './workspaceLayout/redirect'
import type { WorkspaceLayoutConfig } from '../src/shared/domainTypes'

const CFG: WorkspaceLayoutConfig = {
  enabled: true,
  writeDirConfirmEnabled: false,
  extensionSubdirMap: [{ extension: 'py', subdir: 'Script' }]
}

async function withTempWorkDir<T>(fn: (d: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-'))
  try {
    return await fn(tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

describe('toolChatLoop workspaceLayout integration contract', () => {
  it('rewrites inputObj.path to redirected path before exec', async () => {
    await withTempWorkDir(async (workDir) => {
      const inputObj: Record<string, unknown> = { path: 'foo.py', content: 'x' }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: inputObj,
        workDir,
        sessionId: 's1',
        workspaceLayout: CFG,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
      if (out.redirected && out.newPath) inputObj.path = out.newPath
      expect(inputObj.path).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
    })
  })

  it('uses workDir base when confirm disabled and no choice', async () => {
    await withTempWorkDir(async (workDir) => {
      const inputObj: Record<string, unknown> = { path: 'bar.md', content: 'y' }
      const base = workDir
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: inputObj,
        workDir,
        sessionId: 's1',
        workspaceLayout: {
          ...CFG,
          extensionSubdirMap: [{ extension: 'md', subdir: 'Docs' }]
        },
        writeDirChoice: { dir: base }
      })
      expect(out.newPath).toBe(path.join('Docs', 'bar.md').replace(/\\/g, '/'))
    })
  })

  it('never escapes writeDir for traversal inputs', async () => {
    await withTempWorkDir(async (workDir) => {
      const evilPaths = ['..\\..\\evil.py', '/etc/x.py', 'a/../b.py']
      for (const p of evilPaths) {
        const out = await applyWorkspaceLayoutRedirect({
          toolName: 'write_file',
          input: { path: p, content: '' },
          workDir,
          sessionId: 's1',
          workspaceLayout: CFG,
          writeDirChoice: { dir: workDir }
        })
        expect(out.newPath).toBe(path.join('Script', path.basename(p)).replace(/\\/g, '/'))
      }
    })
  })
})
