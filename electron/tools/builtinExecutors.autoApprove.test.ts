import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateFileToolAutoApproval } from './writeFileAutoApproval'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'

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
    const result = await evaluateFileToolAutoApproval({
      workDir,
      userDataDir: path.join(os.tmpdir(), 'sa-userdata-not-workdir'),
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, confirmMode: 'auto' },
      toolName: 'write_file',
      input: { path: 'new.txt', content: 'small' }
    })
    expect(result.approve).toBe(true)
  })

  it('rejects .env path fallback scenario', async () => {
    const result = await evaluateFileToolAutoApproval({
      workDir,
      userDataDir: path.join(os.tmpdir(), 'sa-userdata-not-workdir'),
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, confirmMode: 'auto' },
      toolName: 'write_file',
      input: { path: '.env', content: 'KEY=1' }
    })
    expect(result.approve).toBe(false)
    if (!result.approve) expect(result.reasonCode).toBe('sensitive_path')
  })
})
