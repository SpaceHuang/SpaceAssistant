import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeShellCommand } from './analyzeShellCommand'
import { extractPathLiterals, verifyPathsInWorkDir } from './shellPathAnalysis'

describe('shellPathAnalysis', () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('flags outside workdir path', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-path-'))
    const workDir = path.join(tmpDir, 'proj')
    await fs.mkdir(workDir, { recursive: true })
    const analysis = await analyzeShellCommand(workDir, 'cat ../../../etc/passwd', process.platform)
    expect(analysis.verdict).toBe('ask')
    expect(analysis.shellSecurityHints.requiresRiskAck).toBe(true)
  })

  it('allows in-workdir relative path without risk ack', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-path-'))
    const workDir = path.join(tmpDir, 'proj')
    await fs.mkdir(path.join(workDir, 'src'), { recursive: true })
    const analysis = await analyzeShellCommand(workDir, 'cat src/main.ts', process.platform)
    expect(analysis.verdict).toBe('ask')
    expect(analysis.shellSecurityHints.requiresRiskAck).toBe(false)
  })

  it('detects outsideWorkDirRisk for npm run', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-path-'))
    const workDir = path.join(tmpDir, 'proj')
    await fs.mkdir(workDir, { recursive: true })
    const analysis = await analyzeShellCommand(workDir, 'npm run build', process.platform)
    expect(analysis.shellSecurityHints.outsideWorkDirRisk).toBe(true)
    expect(analysis.shellSecurityHints.requiresRiskAck).toBe(true)
  })

  it('cd outside workdir warns', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-path-'))
    const workDir = path.join(tmpDir, 'proj')
    await fs.mkdir(workDir, { recursive: true })
    const literals = extractPathLiterals('cd ..', 0)
    const verdict = await verifyPathsInWorkDir(workDir, literals)
    expect(verdict.requiresRiskAck).toBe(true)
    expect(verdict.warnings.some((w) => w.includes('cd'))).toBe(true)
  })
})
