import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { resolveShellEnvironment } from './environmentResolver'
import { buildShellEnv } from '../processOutputEncoding'
import { buildShellArgs, WINDOWS_POWERSHELL_PROFILE } from './shellProfiles'

// ===== P0-0 端到端回归（§7.1 #0c，P0-0 验收核心）=====
// 以 Explorer 式源 env（仅混合大小写键、无大写 MSYS 变体）复刻产品管线
// resolveShellEnvironment → buildShellEnv → spawn powershell.exe（产品参数模板）。
// 修复前该场景 11/11 失败（0xFFFF0000 + 8009001d，§2.3.3 X1）；修复后应 rc=0（X2/X3）。
describe('run_shell 根因端到端回归（P0-0，Explorer 式源 env）', () => {
  it('混合大小写 SystemRoot 存活后 powershell 正常启动并自报非空 SystemRoot', async () => {
    if (process.platform !== 'win32') return
    const winDir = 'C:\\WINDOWS'
    const source: NodeJS.ProcessEnv = {
      Path: process.env.Path ?? process.env.PATH ?? 'C:\\Windows\\system32',
      APPDATA: process.env.APPDATA ?? 'C:\\Users\\x\\AppData\\Roaming',
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? 'C:\\Users\\x\\AppData\\Local',
      PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT',
      ProgramFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
      'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      TEMP: process.env.TEMP ?? 'C:\\Users\\x\\AppData\\Local\\Temp',
      TMP: process.env.TMP ?? 'C:\\Users\\x\\AppData\\Local\\Temp',
      USERPROFILE: process.env.USERPROFILE ?? 'C:\\Users\\x',
      SystemRoot: winDir,
      ComSpec: `${winDir}\\system32\\cmd.exe`,
      windir: winDir
    }
    // 与产品管线同款 explicitKeys（runShellPlan.ts:113-115）
    const resolved = resolveShellEnvironment(source, ['DEBUG', 'PLAYWRIGHT_FORCE_TTY', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'], 'win32')
    // 白名单不剔除 SystemRoot/ComSpec；windir 本就不在 BASE_KEYS
    expect(resolved.removedKeys).toEqual(['windir'])
    expect(resolved.env.SystemRoot).toBe(winDir)
    const env = buildShellEnv(resolved.env)
    // 验证必须让目标进程自报（§2.3.3 实验设计要点），不能由中间进程转述
    const command = 'Write-Output ("SR=[" + $env:SystemRoot + "]")'
    const proc = spawn('powershell.exe', buildShellArgs(WINDOWS_POWERSHELL_PROFILE, command), {
      env,
      windowsHide: true,
      shell: false
    })
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      let out = ''
      let err = ''
      proc.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8') })
      proc.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8') })
      proc.on('error', (e) => resolve({ code: -1, out, err: `${err}${e.message}` }))
      proc.on('close', (code) => resolve({ code, out, err }))
    })
    expect(result.err).not.toContain('8009001d')
    expect(result.code).toBe(0)
    expect(result.out).toContain(`SR=[${winDir}]`)
  }, 60_000)
})
