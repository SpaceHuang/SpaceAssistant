import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { invalidateSkillsCache } from '../skills/skillCache'
import { readSkillsToolExecutor, skillsReadTool } from './skillsReadTool'
import type { ToolExecutionContext } from './types'

describe('skills.read tool', () => {
  it('rejects arbitrary paths and accepts only a bounded registered name', async () => {
    const result = await readSkillsToolExecutor({ name: '../secret', max_chars: 100 }, {
      workDir: '/tmp/nonexistent', userDataDir: '/tmp/nonexistent', requestId: 'r', toolUseId: 'u', sessionId: 's',
      sendProgress: () => {}, signal: new AbortController().signal, fileStateCache: {} as never, toolsConfig: {} as never
    })
    expect(result.success).toBe(false)
  })

  it('rejects a Desktop Hosted skill snapshot when the skill body changes before dispatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-read-snapshot-'))
    const workDir = path.join(root, 'project')
    const userDataDir = path.join(root, 'user-data')
    const skillPath = path.join(workDir, '.space-skills', 'snapshot-skill', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, '---\nname: snapshot-skill\ndescription: snapshot test\n---\nAuthorized content.\n')
    invalidateSkillsCache()
    const signal = new AbortController().signal
    const context: ToolExecutionContext = {
      workDir, userDataDir, requestId: 'skills-read-snapshot-request', toolUseId: 'skills-read-snapshot-call',
      sessionId: 'skills-read-snapshot-session', sendProgress: () => undefined, signal,
      fileStateCache: new Map() as never, toolsConfig: {} as never, lane: 'desktop'
    }

    try {
      const handle = await skillsReadTool.begin({ name: 'snapshot-skill' }, {
        requestId: context.requestId, toolUseId: context.toolUseId, executionContext: context
      })
      handle.awaitConfirmation()
      handle.confirm()
      handle.beginValidation()
      await fs.writeFile(skillPath, '---\nname: snapshot-skill\ndescription: snapshot test\n---\nChanged content.\n')
      invalidateSkillsCache()

      await expect(handle.validatePrepared({
        requestId: context.requestId, toolUseId: context.toolUseId, toolName: skillsReadTool.name,
        runtimeContext: context, signal
      })).rejects.toThrow('SNAPSHOT_READ_RESULT_CHANGED')
      handle.fail()
      handle.release()
    } finally {
      invalidateSkillsCache()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
