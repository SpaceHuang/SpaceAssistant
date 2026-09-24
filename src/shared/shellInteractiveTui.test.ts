import { describe, expect, it } from 'vitest'
import { analyzeShellTuiCommand, isInteractiveShellTuiCommand, shellTuiHintLines, shellTuiUndetectableHintLines } from './shellInteractiveTui'

describe('isInteractiveShellTuiCommand', () => {
  it('按命令位识别并避免文件名假阳性', () => {
    expect(analyzeShellTuiCommand('cat htop-report.md').kind).toBe('clear')
    expect(analyzeShellTuiCommand('env sudo vim file').kind).toBe('match')
    expect(analyzeShellTuiCommand('echo $(vim)').kind).toBe('undetectable')
    expect(analyzeShellTuiCommand('git log > top.log').kind).toBe('clear')
    expect(analyzeShellTuiCommand('git add docs/vi-usage.md > /dev/null').kind).toBe('clear')
    expect(analyzeShellTuiCommand('cat htop-report.md > /tmp/x').kind).toBe('clear')
    expect(analyzeShellTuiCommand('less README.md > out.txt').kind).toBe('match')
    expect(analyzeShellTuiCommand("bash -c 'vim README.md'").kind).toBe('undetectable')
    expect(analyzeShellTuiCommand("echo 'ready; less README.md'").kind).toBe('clear')
  })
  it('扫描未被引号保护的组合命令段', () => {
    expect(analyzeShellTuiCommand('echo ready; less README.md')).toMatchObject({ kind: 'match', program: 'less' })
    expect(analyzeShellTuiCommand('printf x | less')).toMatchObject({ kind: 'match', program: 'less' })
    expect(analyzeShellTuiCommand('true && vim README.md')).toMatchObject({ kind: 'match', program: 'vim' })
    expect(analyzeShellTuiCommand('echo ready\nless README.md')).toMatchObject({ kind: 'match', program: 'less' })
    expect(analyzeShellTuiCommand('(true && vim README.md)')).toMatchObject({ kind: 'match', program: 'vim' })
    expect(analyzeShellTuiCommand('printf "x | vim"').kind).toBe('clear')
  })
  it('不会被 env 的赋值或 sudo 的选项参数绕过', () => {
    expect(analyzeShellTuiCommand('env PAGER=cat less README.md')).toMatchObject({ kind: 'match', program: 'less' })
    expect(analyzeShellTuiCommand('env -i PAGER=cat -- less README.md')).toMatchObject({ kind: 'match', program: 'less' })
    expect(analyzeShellTuiCommand('sudo -u user less README.md')).toMatchObject({ kind: 'match', program: 'less' })
    expect(analyzeShellTuiCommand('sudo --user=user -- less README.md')).toMatchObject({ kind: 'match', program: 'less' })
  })
  it('无法可靠解析包装器参数时 fail-closed', () => {
    expect(analyzeShellTuiCommand('sudo -o')).toMatchObject({ kind: 'undetectable', reason: 'unsupported-wrapper' })
    expect(analyzeShellTuiCommand("env 'BROKEN less")).toMatchObject({ kind: 'undetectable' })
  })
  it('detects common TUI commands', () => {
    expect(isInteractiveShellTuiCommand('less README.md')).toBe(true)
    expect(isInteractiveShellTuiCommand('vim src/main.ts')).toBe(true)
    expect(isInteractiveShellTuiCommand('top')).toBe(true)
    expect(isInteractiveShellTuiCommand('npm init')).toBe(true)
    expect(isInteractiveShellTuiCommand('git rebase -i HEAD~3')).toBe(true)
  })

  it('allows non-interactive equivalents', () => {
    expect(isInteractiveShellTuiCommand('npm init -y')).toBe(false)
    expect(isInteractiveShellTuiCommand('git --no-pager log -1')).toBe(false)
    expect(isInteractiveShellTuiCommand('npm install')).toBe(false)
    expect(isInteractiveShellTuiCommand('echo hello')).toBe(false)
  })

  it('界面和模型提示使用同一命中事实，且模型提示无界面专属措辞', () => {
    const verdict = analyzeShellTuiCommand('less README.md')
    expect(verdict.kind).toBe('match')
    if (verdict.kind !== 'match') return
    const modelHints = shellTuiHintLines(verdict)
    expect(modelHints[0]).toContain(verdict.program)
    expect(modelHints.join('\n')).not.toContain('下方按钮')
    expect(modelHints.join('\n')).toContain('不是安全策略拒绝')
  })

  it('不可检测模型提示说明拆分建议且不引导 UI 操作', () => {
    const verdict = analyzeShellTuiCommand("bash -c '$CMD less'")
    expect(verdict.kind).toBe('undetectable')
    if (verdict.kind !== 'undetectable') return
    const modelHints = shellTuiUndetectableHintLines({ reason: 'nested-command-unresolvable', programs: ['less'] })
    expect(modelHints.join('\n')).toContain('less')
    expect(modelHints.join('\n')).toContain('拆分')
    expect(modelHints.join('\n')).not.toContain('按钮')
  })
})
