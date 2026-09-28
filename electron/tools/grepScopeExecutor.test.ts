import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

import { grepFallbackJs, grepWithRg, type GrepExecArgs } from './builtinExecutors'

const baseArgs = (overrides: Partial<GrepExecArgs> = {}): GrepExecArgs => ({
  outputMode: 'files_with_matches',
  ignoreCase: false,
  showLineNumber: true,
  multiline: false,
  headLimit: 100,
  includeIgnored: false,
  ...overrides
})

/** 捕获 rgArgs 的 spawn stub（记录后立即退出 1=no match） */
function capturingSpawn(captured: string[][], stdout = '') {
  return (_binary: string, rgArgs: string[]) => {
    captured.push(rgArgs)
    const proc = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.exit(1)`])
    return proc
  }
}

describe('R6：rg 参数拼装（范围语义）', () => {
  it('T-R6-1：默认——名单 glob + 敏感 glob，不传 --hidden', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rg-scope-'))
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    try {
      const captured: string[][] = []
      await grepWithRg('rg', root, path.resolve(root), 'Needle', baseArgs(), 5000, new AbortController().signal, () => {}, capturingSpawn(captured))
      const rgArgs = captured[0]!
      expect(rgArgs).not.toContain('--hidden')
      // D1：glob 大小写无关消费（--iglob），Secrets/.ENV 变体不绕过排除
      expect(rgArgs).toContain('--iglob')
      expect(rgArgs).not.toContain('--glob')
      expect(rgArgs.filter((a) => a === '!**/node_modules/**').length).toBe(1)
      expect(rgArgs).toContain('!**/.env')
      expect(rgArgs).toContain('!**/secrets/**')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R6-3：include_ignored=true → --hidden 且无名单 glob；敏感 glob 仍在（批量开关不解除敏感）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rg-scope-'))
    try {
      const captured: string[][] = []
      await grepWithRg('rg', root, path.resolve(root), 'Needle', baseArgs({ includeIgnored: true }), 5000, new AbortController().signal, () => {}, capturingSpawn(captured))
      const rgArgs = captured[0]!
      expect(rgArgs).toContain('--hidden')
      expect(rgArgs.filter((a) => a.startsWith('!**/node_modules')).length).toBe(0)
      expect(rgArgs).toContain('!**/.env')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R6-4：显式路径指向隐藏成员（.git/objects）→ --hidden 且无 .git 名单 glob', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rg-scope-'))
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
    try {
      const captured: string[][] = []
      await grepWithRg('rg', root, path.join(root, '.git', 'objects'), 'Needle', baseArgs(), 5000, new AbortController().signal, () => {}, capturingSpawn(captured))
      const rgArgs = captured[0]!
      expect(rgArgs).toContain('--hidden')
      // 只检查 glob 值（searchPath 本身含 .git 字符串，属路径不是排除项）
      expect(rgArgs.filter((a) => a.startsWith('!') && a.includes('.git')).length).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('T-R6-6：显式点名敏感文件 → 不追加敏感 glob（尊重明确意图）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rg-scope-'))
    const envFile = path.join(root, '.env')
    fs.writeFileSync(envFile, 'SECRET=1')
    try {
      const captured: string[][] = []
      await grepWithRg('rg', root, envFile, 'SECRET', baseArgs(), 5000, new AbortController().signal, () => {}, capturingSpawn(captured))
      const rgArgs = captured[0]!
      expect(rgArgs).not.toContain('!**/.env')
      expect(rgArgs[rgArgs.length - 1]).toBe(envFile)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R6：walk 回退与 rg 同语义（T-R6-5）', () => {
  function setupRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-walk-scope-'))
    fs.writeFileSync(path.join(root, 'app.ts'), 'const Needle = 1\n')
    fs.writeFileSync(path.join(root, '.env'), 'NEEDLE=secret\n')
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'config'), '// Needle in git config\n')
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'const Needle = 2\n')
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs', 'readme.md'), 'Needle here\n')
    return root
  }

  it('默认：隐藏条目与名单成员不搜（.env / .git / node_modules 均跳过）', async () => {
    const root = setupRoot()
    try {
      const out = await grepFallbackJs(root, path.resolve(root), 'Needle', baseArgs(), new AbortController().signal, () => {})
      expect(out).toContain('app.ts')
      expect(out).toContain('docs')
      expect(out).not.toContain('.env')
      expect(out).not.toMatch(/\.git[\\/]config/)
      expect(out).not.toContain('index.js')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('include_ignored：隐藏非敏感条目（.git）与名单成员命中；敏感 .env 仍排除（两引擎一致）', async () => {
    const root = setupRoot()
    try {
      const out = await grepFallbackJs(root, path.resolve(root), 'Needle', baseArgs({ includeIgnored: true }), new AbortController().signal, () => {})
      expect(out).toContain('app.ts')
      expect(out).toMatch(/\.git[\\/]config/)
      expect(out).toContain('index.js')
      expect(out).not.toContain('secret')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('显式点名 .env 文件：可搜（尊重明确意图，与 rg 一致）', async () => {
    const root = setupRoot()
    try {
      const out = await grepFallbackJs(root, path.join(root, '.env'), 'NEEDLE', baseArgs(), new AbortController().signal, () => {})
      expect(out).toContain('.env')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
