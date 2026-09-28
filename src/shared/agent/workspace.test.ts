import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertWorkspaceBasisConsistent,
  normalizeWorkspaceRoot,
  workspacePathKey,
  type WorkspaceSnapshot,
} from './workspace'

const isWin = process.platform === 'win32'

function sampleRoot(): string {
  return path.join(process.cwd(), 'work', 'project')
}

function sampleSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  const rootPath = sampleRoot()
  return {
    profileId: 'profile-a',
    rootPath,
    key: workspacePathKey(rootPath),
    source: 'session-binding',
    sensitive: false,
    revision: 1,
    ...overrides,
  }
}

describe('normalizeWorkspaceRoot', () => {
  it('去掉尾部分隔符', () => {
    expect(normalizeWorkspaceRoot(sampleRoot() + path.sep)).toBe(sampleRoot())
  })

  it('相对路径解析为绝对路径', () => {
    const resolved = normalizeWorkspaceRoot('sub/dir')
    expect(path.isAbsolute(resolved)).toBe(true)
  })

  it('折叠重复分隔符与上级引用', () => {
    const root = sampleRoot()
    const withParent = path.join(root, '..', 'project')
    expect(normalizeWorkspaceRoot(withParent)).toBe(normalizeWorkspaceRoot(root))
  })

  it('空串不抛错且可得到绝对路径', () => {
    expect(path.isAbsolute(normalizeWorkspaceRoot(''))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('C1：Windows 盘符根保留尾分隔符（E:\\ 不退化为 E:）', () => {
    expect(normalizeWorkspaceRoot('E:\\')).toBe('E:\\')
    expect(normalizeWorkspaceRoot('E:/')).toBe('E:\\')
    expect(normalizeWorkspaceRoot('E:')).toBe('E:\\')
    // 归一结果必须是「可作 resolve 基座」形态：resolve(root, 'x') 落在盘根，不漂移到 cwd
    expect(path.win32.resolve(normalizeWorkspaceRoot('E:\\'), 'x')).toBe('E:\\x')
  })

  it('C1（跨平台）：盘符根 key 不依赖进程 cwd', () => {
    if (process.platform === 'win32') {
      expect(workspacePathKey('E:\\', 'win32')).toBe('e:/')
    } else {
      expect(workspacePathKey('/', 'linux')).toBe('/')
    }
  })
})

describe('workspacePathKey', () => {
  it('win32：小写 + 正斜杠（与 electron/writeSafety/pathIdentity 口径一致）', () => {
    expect(workspacePathKey('C:\\Work\\Project', 'win32')).toBe('c:/work/project')
    expect(workspacePathKey('C:\\WORK\\Project\\', 'win32')).toBe('c:/work/project')
  })

  it('win32：大小写与分隔符归一后同一路径同键', () => {
    expect(workspacePathKey('C:\\a\\B', 'win32')).toBe(workspacePathKey('c:/A/b', 'win32'))
  })

  it('win32：尾分隔符不影响键', () => {
    expect(workspacePathKey('C:\\work\\project\\', 'win32')).toBe(
      workspacePathKey('C:\\work\\project', 'win32')
    )
  })

  it('posix：保持大小写原样', () => {
    expect(workspacePathKey('/home/User/Project', 'linux')).toBe('/home/User/Project')
    expect(workspacePathKey('/home/User/Project', 'linux')).not.toBe('/home/user/project')
  })

  it('未显式给 platform 时按 process.platform 计算', () => {
    const key = workspacePathKey('/Some/Path')
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })
})

describe('assertWorkspaceBasisConsistent', () => {
  it('四消费点同一 workDir 时 ok', () => {
    const snapshot = sampleSnapshot()
    const result = assertWorkspaceBasisConsistent({
      snapshot,
      consumers: [
        { name: 'env', workDir: snapshot.rootPath },
        { name: 'file', workDir: snapshot.rootPath },
        { name: 'shell', workDir: snapshot.rootPath },
        { name: 'safety', workDir: snapshot.rootPath },
      ],
    })
    expect(result).toEqual({ ok: true })
  })

  it('单一消费点漂移时报出该点', () => {
    const snapshot = sampleSnapshot()
    const other = path.join(process.cwd(), 'other', 'dir')
    const result = assertWorkspaceBasisConsistent({
      snapshot,
      consumers: [
        { name: 'env', workDir: other },
        { name: 'file', workDir: snapshot.rootPath },
        { name: 'shell', workDir: snapshot.rootPath },
        { name: 'safety', workDir: snapshot.rootPath },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.mismatches).toEqual([{ name: 'env', workDir: other }])
    }
  })

  it.runIf(isWin)('比较按 workspacePathKey 而非字面字符串（win32 大小写漂移不算不一致）', () => {
    const snapshot = sampleSnapshot()
    const drift = snapshot.rootPath.toUpperCase()
    const result = assertWorkspaceBasisConsistent({
      snapshot,
      consumers: [
        { name: 'env', workDir: drift },
        { name: 'file', workDir: snapshot.rootPath },
      ],
    })
    expect(result).toEqual({ ok: true })
  })
})
