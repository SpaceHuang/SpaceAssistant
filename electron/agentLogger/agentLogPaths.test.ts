import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  formatAgentLogDateKey,
  formatAgentLogFileName,
  isAgentLogProductionMode,
  resolveAgentLogDir,
  resolveDevAgentLogDir
} from './agentLogPaths'

/** 使用绝对路径 fixture，避免 Linux CI 将 `C:/...` 当作相对路径段。 */
const fixtureProjectRoot = path.resolve('/space-assistant-fixture')
const fixtureMainDir = path.join(fixtureProjectRoot, 'dist-electron', 'electron')
const fixtureDevLogsDir = path.join(fixtureProjectRoot, 'logs')
const fixtureWorkDir = path.resolve('/space-assistant-workdir')

describe('agentLogPaths', () => {
  it('formats date key and file name', () => {
    const date = new Date(2026, 4, 16, 12, 0, 0)
    expect(formatAgentLogDateKey(date)).toBe('20260516')
    expect(formatAgentLogFileName(date)).toBe('Agent-20260516.log')
  })

  it('resolves dev log dir relative to main dirname', () => {
    expect(resolveDevAgentLogDir(fixtureMainDir)).toBe(fixtureDevLogsDir)
  })

  it('resolves packaged log dir under workDir', () => {
    expect(resolveAgentLogDir(true, fixtureWorkDir, fixtureMainDir)).toBe(
      path.join(fixtureWorkDir, '.agent', 'logs')
    )
  })

  it('resolves dev log dir when not packaged', () => {
    expect(resolveAgentLogDir(false, fixtureWorkDir, fixtureMainDir)).toBe(fixtureDevLogsDir)
  })

  it('production mode flag matches packaged app', () => {
    expect(isAgentLogProductionMode(true)).toBe(true)
    expect(isAgentLogProductionMode(false)).toBe(false)
  })
})
