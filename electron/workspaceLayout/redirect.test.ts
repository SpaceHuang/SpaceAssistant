import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { applyWorkspaceLayoutRedirect, resolveWriteDirBase } from './redirect'
import { DEFAULT_WIKI_CONFIG, type WikiConfig, type WorkspaceLayoutConfig } from '../../src/shared/domainTypes'

const ENABLED: WorkspaceLayoutConfig = {
  enabled: true,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [
    { extension: 'py', subdir: 'Script' },
    { extension: 'md', subdir: 'Docs' }
  ]
}

async function withTempWorkDir<T>(fn: (workDir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wsl-'))
  try {
    return await fn(tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

describe('applyWorkspaceLayoutRedirect', () => {
  it('bypasses when disabled', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: { ...ENABLED, enabled: false },
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
      expect(out.newPath).toBeUndefined()
    })
  })

  it('skips edit_file', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'edit_file',
        input: { path: 'foo.py', old_string: 'a', new_string: 'b' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('redirects new py file into Script subdir', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
    })
  })

  it('discards traversal and keeps only basename', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: '..\\..\\evil.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'evil.py').replace(/\\/g, '/'))
    })
  })

  it('rejects absolute path input by treating as basename only (no escape)', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: '/etc/passwd.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'passwd.py').replace(/\\/g, '/'))
    })
  })

  it('unmapped extension falls to root of writeDir', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'deep/notes.log', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe('notes.log')
    })
  })

  it('is case-insensitive on extension', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'FOO.PY', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.newPath).toBe(path.join('Script', 'FOO.PY').replace(/\\/g, '/'))
    })
  })

  it('uses last extension (a.py.bak -> bak)', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'a.py.bak', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('does not redirect when target file already exists', async () => {
    await withTempWorkDir(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'sub'), { recursive: true })
      await fs.writeFile(path.join(workDir, 'sub', 'exists.py'), 'x')
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'sub/exists.py', content: 'y' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('rejects basename equal to .. or containing separators', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: '..', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.reject).toBe(true)
      expect(out.rejectReason).toBeTruthy()
    })
  })

  it('does not attach reason when already compliant', async () => {
    await withTempWorkDir(async (workDir) => {
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'Script/foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir }
      })
      expect(out.redirected).toBe(false)
      expect(out.reason).toBeUndefined()
    })
  })

  it('bypasses llm-wiki wiki/ paths (own layout)', async () => {
    await withTempWorkDir(async (workDir) => {
      const wiki: WikiConfig = { ...DEFAULT_WIKI_CONFIG, enabled: true }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'llm-wiki/wiki/entities/foo.md', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir },
        wikiConfig: wiki
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('bypasses llm-wiki raw/ paths (own layout)', async () => {
    await withTempWorkDir(async (workDir) => {
      const wiki: WikiConfig = { ...DEFAULT_WIKI_CONFIG, enabled: true }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'llm-wiki/raw/notes.md', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir },
        wikiConfig: wiki
      })
      expect(out.redirected).toBe(false)
    })
  })

  it('still redirects non-wiki py file when wiki enabled', async () => {
    await withTempWorkDir(async (workDir) => {
      const wiki: WikiConfig = { ...DEFAULT_WIKI_CONFIG, enabled: true }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'foo.py', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir },
        wikiConfig: wiki
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Script', 'foo.py').replace(/\\/g, '/'))
    })
  })

  it('still redirects wiki-rooted md when wiki disabled', async () => {
    await withTempWorkDir(async (workDir) => {
      const wiki: WikiConfig = { ...DEFAULT_WIKI_CONFIG, enabled: false }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: { path: 'llm-wiki/wiki/foo.md', content: '' },
        workDir,
        sessionId: 's1',
        workspaceLayout: ENABLED,
        writeDirChoice: { dir: workDir },
        wikiConfig: wiki
      })
      expect(out.redirected).toBe(true)
      expect(out.newPath).toBe(path.join('Docs', 'foo.md').replace(/\\/g, '/'))
    })
  })
})

describe('resolveWriteDirBase', () => {
  it('returns writeDirChoice.dir when present', () => {
    expect(resolveWriteDirBase({ dir: 'D:/proj' })).toBe('D:/proj')
  })

  it('falls back to workDir when writeDirChoice null and confirm disabled', () => {
    expect(resolveWriteDirBase(null, 'D:/work')).toBe('D:/work')
  })
})
