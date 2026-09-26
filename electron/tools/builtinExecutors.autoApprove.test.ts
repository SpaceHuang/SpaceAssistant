import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateFileToolAutoApproval } from './writeFileAutoApproval'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { WritePathFact } from '../confirmation/extractors/writePathFacts'
import { probeWritePathFact } from '../confirmation/extractors/writePathFacts'

describe('file auto approval integration', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-auto-'))
    await fs.writeFile(path.join(workDir, 'ok.txt'), 'hello', 'utf8')
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('approves small write in workDir', async () => {
    const input = { path: 'new.txt', content: 'small' }
    const writePathFact = await probeWritePathFact({ rawPath: input.path, workDir, userDataDir: path.join(os.tmpdir(), 'sa-userdata-not-workdir'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const result = await evaluateFileToolAutoApproval({
      workDir,
      userDataDir: path.join(os.tmpdir(), 'sa-userdata-not-workdir'),
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
      toolName: 'write_file',
      input,
      writePathFact
    })
    expect(result.approve).toBe(true)
  })

  it('rejects .env path fallback scenario', async () => {
    const input = { path: '.env', content: 'KEY=1' }
    const writePathFact = await probeWritePathFact({ rawPath: input.path, workDir, userDataDir: path.join(os.tmpdir(), 'sa-userdata-not-workdir'), homeDir: os.homedir(), customSensitivePrefixes: [] })
    const result = await evaluateFileToolAutoApproval({
      workDir,
      userDataDir: path.join(os.tmpdir(), 'sa-userdata-not-workdir'),
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
      toolName: 'write_file',
      input,
      writePathFact
    })
    expect(result.approve).toBe(false)
    if (!result.approve) expect(result.reasonCode).toBe('sensitive_path')
  })

  it('production file auto approval consumes a precomputed outside fact', async () => {
    const target = path.join(path.dirname(workDir), 'outside-auto-approval.txt')
    const fact: WritePathFact = {
      rawPath: target, normalizedPath: target, zone: 'outside-workdir', targetKind: 'missing',
      parentReal: path.dirname(target), parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 1 }
    }
    const result = await evaluateFileToolAutoApproval({
      workDir,
      userDataDir: path.join(path.dirname(workDir), 'userdata'),
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
      toolName: 'write_file',
      input: { path: target, content: 'x' },
      writePathFact: fact
    })
    expect(result).toMatchObject({ approve: false, reasonCode: 'outside_workdir' })
  })

  it('missing path is reported as an input error rather than a sensitive-path rejection', async () => {
    const result = await evaluateFileToolAutoApproval({
      workDir,
      userDataDir: path.join(path.dirname(workDir), 'userdata'),
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
      toolName: 'write_file',
      input: { content: 'x' }
    })
    expect(result).toMatchObject({ approve: false, reasonCode: 'invalid_path' })
  })
})
