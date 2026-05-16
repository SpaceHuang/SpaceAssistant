import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  formatAgentLogDateKey,
  formatAgentLogFileName,
  resolveAgentLogDir,
  resolveDevAgentLogDir
} from './agentLogPaths'

describe('agentLogPaths', () => {
  it('formats date key and file name', () => {
    const date = new Date(2026, 4, 16, 12, 0, 0)
    expect(formatAgentLogDateKey(date)).toBe('20260516')
    expect(formatAgentLogFileName(date)).toBe('Agent-20260516.log')
  })

  it('resolves dev log dir relative to main dirname', () => {
    const mainDir = path.join('C:', 'project', 'dist-electron', 'electron')
    expect(resolveDevAgentLogDir(mainDir)).toBe(path.join('C:', 'project', 'logs'))
  })

  it('resolves packaged log dir under workDir', () => {
    const workDir = path.join('D:', 'work', 'root')
    const mainDir = path.join('C:', 'app', 'dist-electron', 'electron')
    expect(resolveAgentLogDir(true, workDir, mainDir)).toBe(path.join(workDir, '.agent', 'logs'))
  })

  it('resolves dev log dir when not packaged', () => {
    const mainDir = path.join('C:', 'project', 'dist-electron', 'electron')
    expect(resolveAgentLogDir(false, path.join('D:', 'work', 'root'), mainDir)).toBe(path.join('C:', 'project', 'logs'))
  })
})
