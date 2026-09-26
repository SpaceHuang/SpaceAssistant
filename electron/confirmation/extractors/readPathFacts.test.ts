import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { classifyReadPathZone, probeReadPathFact } from './readPathFacts'
import { runExtractorsWithReadPathFact } from './runExtractors'

describe('probeReadPathFact', () => {
  it('POSIX 工作目录归属比较保留大小写', () => {
    expect(classifyReadPathZone({
      rawPath: '/tmp/work/secret.txt', workDir: '/tmp/Work', userDataDir: '/tmp/user-data',
      homeDir: '/tmp/home', customSensitivePrefixes: [], resolvedPath: '/tmp/work/secret.txt'
    })).toBe('outside-workdir')
  })

  it('Windows 工作目录归属比较忽略大小写', () => {
    expect(classifyReadPathZone({
      rawPath: 'C:\\work\\secret.txt', workDir: 'C:\\Work', userDataDir: 'C:\\user-data',
      homeDir: 'C:\\Users\\alice', customSensitivePrefixes: [], resolvedPath: 'C:\\work\\secret.txt'
    })).toBe('workdir-normal')
  })

  it.each(['/System/Library/CoreServices/SystemVersion.plist', '/Library/Preferences/com.apple.test.plist'])(
    '识别 macOS 系统目录 %s', (resolvedPath) => {
      expect(classifyReadPathZone({
        rawPath: resolvedPath, workDir: '/tmp/work', userDataDir: '/tmp/user-data',
        homeDir: '/tmp/home', customSensitivePrefixes: [], resolvedPath
      })).toBe('system-dir')
    }
  )

  it('识别 macOS /var 的真实系统路径，并保留 /private/var/folders 下的工作目录分类', () => {
    expect(classifyReadPathZone({
      rawPath: '/var/log/install.log', workDir: '/tmp/work', userDataDir: '/tmp/user-data',
      homeDir: '/tmp/home', customSensitivePrefixes: [], resolvedPath: '/private/var/log/install.log'
    })).toBe('system-dir')
    expect(classifyReadPathZone({
      rawPath: '/private/var/folders/ab/work/note.txt', workDir: '/private/var/folders/ab/work',
      userDataDir: '/tmp/user-data', homeDir: '/tmp/home', customSensitivePrefixes: [],
      resolvedPath: '/private/var/folders/ab/work/note.txt'
    })).toBe('workdir-normal')
  })

  it('对存在的 /var/log 探测真实路径后仍分类为 system-dir', async () => {
    if (process.platform !== 'darwin') return
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-var-root-')))
    try {
      const realVarLog = await fs.realpath('/var/log')
      await expect(probeReadPathFact({
        rawPath: '/var/log', workDir: root, userDataDir: path.join(root, 'user-data'),
        homeDir: path.join(root, 'home'), customSensitivePrefixes: []
      })).resolves.toMatchObject({ normalizedPath: realVarLog, zone: 'system-dir', targetKind: 'directory' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('feeds the probed fact into the existing extractor flow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    try {
      await fs.writeFile(path.join(root, 'note.txt'), 'hello')
      const result = await runExtractorsWithReadPathFact(
        { toolName: 'read_file', actionClass: 'read', riskLevel: 'low', extractors: [] },
        { path: 'note.txt' },
        { os: 'darwin', workDir: root, sensitivePaths: [], userDataDir: path.join(root, 'user-data'), homeDir: path.join(root, 'home') }
      )
      expect(result.readPathFact.targetKind).toBe('file')
      expect(result.facts.signals).toContainEqual({ kind: 'path-target', path: result.readPathFact.normalizedPath, zone: 'workdir-normal' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('returns a workdir-normal file fact with an absolute path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    try {
      const file = path.join(root, 'note.txt')
      await fs.writeFile(file, 'hello')
      await expect(probeReadPathFact({
      rawPath: 'note.txt',
      workDir: root,
      userDataDir: path.join(root, 'user-data'),
      homeDir: path.join(root, 'home'),
      customSensitivePrefixes: []
      })).resolves.toMatchObject({
        normalizedPath: await fs.realpath(file),
      zone: 'workdir-normal',
      targetKind: 'file',
      scope: 'single-target'
      })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('keeps missing targets as absolute missing facts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    try { await expect(probeReadPathFact({
      rawPath: 'missing.txt',
      workDir: root,
      userDataDir: path.join(root, 'user-data'),
      homeDir: path.join(root, 'home'),
      customSensitivePrefixes: []
      })).resolves.toMatchObject({
      normalizedPath: path.join(await fs.realpath(root), 'missing.txt'),
      targetKind: 'missing',
      zone: 'workdir-normal'
      })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('raises a typed environment error when target probing fails with EACCES', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-eacces-'))
    const file = path.join(root, 'blocked.txt')
    await fs.writeFile(file, 'blocked')
    const originalLstat = fs.lstat.bind(fs)
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
      if (String(target) === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return originalLstat(target, ...args)
    })
    try {
      await expect(probeReadPathFact({ rawPath: file, workDir: root, userDataDir: path.join(root, 'user-data'), homeDir: path.join(root, 'home'), customSensitivePrefixes: [] }))
        .rejects.toMatchObject({ name: 'ReadPathProbeError', failureClass: 'environment', caseId: 'read-path-probe-environment-error', code: 'EACCES' })
    } finally {
      lstatSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('raises a typed environment error instead of lexically falling back when canonicalization fails with EIO', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-realpath-eio-'))
    const originalRealpath = fs.realpath.bind(fs)
    const realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...args) => {
      if (String(target) === root) throw Object.assign(new Error('I/O error'), { code: 'EIO' })
      return originalRealpath(target, ...args)
    })
    try {
      await expect(probeReadPathFact({ rawPath: 'note.txt', workDir: root, userDataDir: path.join(root, 'user-data'), homeDir: path.join(root, 'home'), customSensitivePrefixes: [] }))
        .rejects.toMatchObject({ name: 'ReadPathProbeError', failureClass: 'environment', caseId: 'read-path-probe-environment-error', code: 'EIO' })
    } finally {
      realpathSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('classifies a symlink to an outside file by its real target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-out-'))
    try {
      const target = path.join(outside, 'secret.txt')
      const link = path.join(root, 'link.txt')
      await fs.writeFile(target, 'secret')
      await fs.symlink(target, link)
      await expect(probeReadPathFact({
      rawPath: 'link.txt',
      workDir: root,
      userDataDir: path.join(root, 'user-data'),
      homeDir: path.join(root, 'home'),
      customSensitivePrefixes: []
      })).resolves.toMatchObject({
      normalizedPath: await fs.realpath(target),
      zone: 'outside-workdir',
      targetKind: 'symlink'
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('classifies a directory symlink as symlink while using the real directory zone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-out-'))
    try {
      await fs.symlink(outside, path.join(root, 'link-dir'))
      await expect(probeReadPathFact({ rawPath: 'link-dir', workDir: root, userDataDir: path.join(root, 'user-data'), homeDir: path.join(root, 'home'), customSensitivePrefixes: [] })).resolves.toMatchObject({ targetKind: 'symlink', zone: 'outside-workdir', normalizedPath: await fs.realpath(outside) })
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }) }
  })

  it('resolves a parent directory symlink before classifying the target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-out-'))
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
      await fs.symlink(outside, path.join(root, 'link'))
      await expect(probeReadPathFact({ rawPath: 'link/secret.txt', workDir: root, userDataDir: path.join(root, 'user-data'), homeDir: path.join(root, 'home'), customSensitivePrefixes: [] })).resolves.toMatchObject({ zone: 'outside-workdir', targetKind: 'file' })
    } finally {
      await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('uses the supplied homeDir when matching sensitive paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-facts-'))
    const home = path.join(root, 'fixture-home')
    const file = path.join(home, '.ssh', 'id_rsa')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'key')

    try { await expect(probeReadPathFact({
      rawPath: file,
      workDir: root,
      userDataDir: path.join(root, 'user-data'),
      homeDir: home,
      customSensitivePrefixes: []
      })).resolves.toMatchObject({
      normalizedPath: await fs.realpath(file),
      zone: 'sensitive-file',
      targetKind: 'file'
      })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('uses a non-C Windows SystemRoot when classifying native paths', async () => {
    vi.stubEnv('SystemRoot', 'D:\\CustomWindows')
    try {
      await expect(probeReadPathFact({
        rawPath: 'D:\\CustomWindows\\System32\\config\\SAM',
        workDir: 'D:\\Workspace',
        userDataDir: 'D:\\Workspace\\user-data',
        homeDir: 'D:\\Users\\alice',
        customSensitivePrefixes: []
      })).resolves.toMatchObject({ normalizedPath: 'D:\\CustomWindows\\System32\\config\\SAM', zone: 'system-dir' })

      await expect(probeReadPathFact({
        rawPath: 'E:\\Documents\\notes.txt',
        workDir: 'D:\\Workspace',
        userDataDir: 'D:\\Workspace\\user-data',
        homeDir: 'D:\\Users\\alice',
        customSensitivePrefixes: []
      })).resolves.toMatchObject({ zone: 'outside-workdir' })
    } finally { vi.unstubAllEnvs() }
  })
})
