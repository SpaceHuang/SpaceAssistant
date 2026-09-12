import { describe, expect, it } from 'vitest'
import { MACOS_BASH_PROFILE, WINDOWS_POWERSHELL_PROFILE } from './shellProfiles'
import { buildTerminalToolContract, freezeTerminalProfileSnapshot } from './terminalToolContract'

describe('buildTerminalToolContract', () => {
  it('将 Bash profile 的方言、executable 和 cwd 注入工具合同', () => {
    const contract = buildTerminalToolContract({
      profile: MACOS_BASH_PROFILE, os: 'darwin', cwd: '/tmp/project»name', pathSeparator: '/', supportsAnsi: true, supportsTty: false
    })
    expect(contract.toolName).toBe('run_shell')
    expect(contract.description).toContain('dialect=posix-bash')
    expect(contract.description).toContain('当前 OS=darwin')
    expect(contract.description).toContain('$NODE_ENV')
    expect(contract.description).toContain('&&、; 或管道')
    expect(contract.description).toContain('«/tmp/project›name»')
    expect(contract.description).toContain('不要使用 $env:NAME')
    expect(contract.capabilityBlock).toContain('shell_profile_id: builtin-macos-bash')
    expect(contract.capabilityBlock).toContain('output_encoding: utf8')
  })

  it('为 PowerShell 明确禁止 Bash 方言并保留结构化环境字段', () => {
    const contract = buildTerminalToolContract({
      profile: WINDOWS_POWERSHELL_PROFILE, os: 'win32', cwd: 'C:\\work', pathSeparator: '\\', supportsAnsi: false, supportsTty: false
    })
    expect(contract.description).toContain('Windows PowerShell 5.1')
    expect(contract.description).toContain('不要使用 export')
    expect(contract.description).toContain('当前 OS=win32')
    expect(contract.description).toContain('$env:NODE_ENV')
    expect(contract.capabilityBlock).toContain('dialect: windows-powershell')
    expect(contract.capabilityBlock).toMatch(/output_encoding: (utf8|auto|oem:\d+)/)
    expect(contract.capabilityBlock).toContain('executable: «powershell.exe»')
    // 决策点 D7：native 输出的中文不得用 PS 变量/管道承接
    expect(contract.description).toContain('native 工具')
    expect(contract.description).toContain('不可逆')
  })

  it('D7：POSIX 方言不注入 native 文本规则（避免无关噪声）', () => {
    const contract = buildTerminalToolContract({
      profile: MACOS_BASH_PROFILE, os: 'darwin', cwd: '/tmp', pathSeparator: '/', supportsAnsi: true, supportsTty: false
    })
    expect(contract.description).not.toContain('native 工具')
  })

  it('terminal contract 使用冻结的 profile snapshot', () => {
    const snapshot = freezeTerminalProfileSnapshot({
      profile: MACOS_BASH_PROFILE, os: 'darwin', cwd: '/tmp', pathSeparator: '/', supportsAnsi: true, supportsTty: false
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.profile)).toBe(true)
    expect(() => { ;(snapshot as { cwd: string }).cwd = '/other' }).toThrow()
  })
})
