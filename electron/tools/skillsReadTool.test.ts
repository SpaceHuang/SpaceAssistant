import { describe, expect, it } from 'vitest'
import { createSkillTurnScope } from '../skills/skillTurnScope'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { readSkillsToolExecutor, skillsReadTool } from './skillsReadTool'
import type { ToolExecutionContext } from './types'

function skill(name: string, content: string): SkillDefinition {
  return {
    meta: { name, description: `${name} helper`, triggers: [], version: '1', author: '' },
    content, scope: 'user', directoryPath: `/private/${name}`, filePath: `/private/${name}/SKILL.md`, lastModified: 1
  }
}

function runtimeContext(scope: ReturnType<typeof createSkillTurnScope>, signal = new AbortController().signal): ToolExecutionContext {
  return {
    workDir: '/tmp', userDataDir: '/tmp', requestId: 'skills-read-request', toolUseId: 'skills-read-call',
    sessionId: 'skills-read-session', sendProgress: () => undefined, signal, fileStateCache: new Map() as never,
    toolsConfig: {} as never, lane: 'desktop', skillTurnScope: scope
  }
}

describe('skills.read tool', () => {
  it('rejects arbitrary paths and requires an accepted Desktop turn scope', async () => {
    const result = await readSkillsToolExecutor({ name: '../secret', max_chars: 100 }, {
      ...runtimeContext(createSkillTurnScope({ catalogSkills: [], preloadedSkills: [], maxConcurrent: 1 })),
      skillTurnScope: undefined
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('SKILL_TURN_SCOPE_REQUIRED')
  })

  it('reads the accepted body after the cache source changes; a later turn sees its own snapshot', async () => {
    const v1 = skill('snapshot-skill', 'Authorized content v1.')
    const scope = createSkillTurnScope({ catalogSkills: [v1], preloadedSkills: [], maxConcurrent: 2 })
    const runtime = runtimeContext(scope)
    const invocationContext = { requestId: runtime.requestId, toolUseId: runtime.toolUseId, executionContext: runtime, signal: runtime.signal }
    const execution = { requestId: runtime.requestId, toolUseId: runtime.toolUseId, toolName: skillsReadTool.name, runtimeContext: runtime, signal: runtime.signal }

    const handle = await skillsReadTool.begin({ name: 'snapshot-skill' }, invocationContext)
    expect(scope.committedNames).toEqual([])
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()
    v1.content = 'Changed after acceptance.'
    await handle.validatePrepared(execution)
    handle.finishValidation()
    await expect(handle.execute(execution)).resolves.toEqual({ success: true, data: { name: 'snapshot-skill', content: 'Authorized content v1.' } })
    expect(scope.committedNames).toEqual(['snapshot-skill'])

    const nextScope = createSkillTurnScope({ catalogSkills: [skill('snapshot-skill', 'Authorized content v2.')], preloadedSkills: [], maxConcurrent: 2 })
    expect(nextScope.planRead('snapshot-skill', 100).content).toBe('Authorized content v2.')
    scope.close()
    nextScope.close()
  })

  it('plan and validate do not consume a slot; closing the turn rejects before execution', async () => {
    const scope = createSkillTurnScope({ catalogSkills: [skill('alpha', 'A'), skill('beta', 'B')], preloadedSkills: [], maxConcurrent: 1 })
    const runtime = runtimeContext(scope)
    const handle = await skillsReadTool.begin({ name: 'alpha' }, {
      requestId: runtime.requestId, toolUseId: runtime.toolUseId, executionContext: runtime, signal: runtime.signal
    })
    expect(scope.committedNames).toEqual([])
    scope.close()
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()
    await expect(handle.validatePrepared({
      requestId: runtime.requestId, toolUseId: runtime.toolUseId, toolName: skillsReadTool.name,
      runtimeContext: runtime, signal: runtime.signal
    })).rejects.toThrow('SKILL_TURN_SCOPE_CLOSED')
    handle.fail()
    handle.release()
    expect(scope.committedNames).toEqual([])
  })

  it('does not spend the last slot for an aborted execute or an over-budget name', async () => {
    const scope = createSkillTurnScope({ catalogSkills: [skill('alpha', 'A'), skill('beta', 'B')], preloadedSkills: [], maxConcurrent: 1 })
    const controller = new AbortController()
    const runtime = runtimeContext(scope, controller.signal)
    const prepared = await skillsReadTool.begin({ name: 'alpha' }, {
      requestId: runtime.requestId, toolUseId: runtime.toolUseId, executionContext: runtime, signal: runtime.signal
    })
    prepared.awaitConfirmation()
    prepared.confirm()
    prepared.beginValidation()
    await prepared.validatePrepared({ requestId: runtime.requestId, toolUseId: runtime.toolUseId, toolName: skillsReadTool.name, runtimeContext: runtime, signal: runtime.signal })
    prepared.finishValidation()
    controller.abort()
    await expect(prepared.execute({ requestId: runtime.requestId, toolUseId: runtime.toolUseId, toolName: skillsReadTool.name, runtimeContext: runtime, signal: runtime.signal }))
      .rejects.toThrow('REQUEST_CANCELLED')
    expect(scope.committedNames).toEqual([])

    const beta = scope.planRead('beta', 100)
    scope.close()
    expect(beta.content).toBe('B')
    expect(scope.committedNames).toEqual([])
  })

  it('serially commits different names racing for the final slot and keeps same-name reads idempotent', async () => {
    const scope = createSkillTurnScope({ catalogSkills: [skill('alpha', 'A'), skill('beta', 'B')], preloadedSkills: [], maxConcurrent: 1 })
    const signal = new AbortController().signal
    const makeExecution = (toolUseId: string) => {
      const runtime = { ...runtimeContext(scope, signal), toolUseId }
      return {
        runtime,
        context: { requestId: runtime.requestId, toolUseId, toolName: skillsReadTool.name, runtimeContext: runtime, signal }
      }
    }
    const prepare = async (name: string, toolUseId: string) => {
      const { runtime, context } = makeExecution(toolUseId)
      const handle = await skillsReadTool.begin({ name }, {
        requestId: runtime.requestId, toolUseId, executionContext: runtime, signal
      })
      handle.awaitConfirmation()
      handle.confirm()
      handle.beginValidation()
      await handle.validatePrepared(context)
      handle.finishValidation()
      return { handle, context }
    }

    const [alphaA, alphaB] = await Promise.all([prepare('alpha', 'call-a'), prepare('alpha', 'call-b')])
    const sameName = await Promise.all([alphaA.handle.execute(alphaA.context), alphaB.handle.execute(alphaB.context)])
    expect(sameName).toEqual([
      { success: true, data: { name: 'alpha', content: 'A' } },
      { success: true, data: { name: 'alpha', content: 'A' } }
    ])
    expect(scope.committedNames).toEqual(['alpha'])

    const isolatedScope = createSkillTurnScope({ catalogSkills: [skill('alpha', 'A'), skill('beta', 'B')], preloadedSkills: [], maxConcurrent: 1 })
    const first = await (async () => {
      const runtime = runtimeContext(isolatedScope)
      const context = { requestId: 'skills-read-request', toolUseId: 'left', toolName: skillsReadTool.name, runtimeContext: runtime, signal: runtime.signal }
      const handle = await skillsReadTool.begin({ name: 'alpha' }, { requestId: runtime.requestId, toolUseId: 'left', executionContext: runtime, signal: runtime.signal })
      handle.awaitConfirmation(); handle.confirm(); handle.beginValidation(); await handle.validatePrepared(context); handle.finishValidation()
      return { handle, context }
    })()
    const second = await (async () => {
      const runtime = runtimeContext(isolatedScope)
      const context = { requestId: 'skills-read-request', toolUseId: 'right', toolName: skillsReadTool.name, runtimeContext: runtime, signal: runtime.signal }
      const handle = await skillsReadTool.begin({ name: 'beta' }, { requestId: runtime.requestId, toolUseId: 'right', executionContext: runtime, signal: runtime.signal })
      handle.awaitConfirmation(); handle.confirm(); handle.beginValidation(); await handle.validatePrepared(context); handle.finishValidation()
      return { handle, context }
    })()
    const racing = await Promise.all([first.handle.execute(first.context), second.handle.execute(second.context)])
    expect(racing.filter((result) => result.success)).toHaveLength(1)
    expect(isolatedScope.committedNames).toHaveLength(1)
    scope.close()
    isolatedScope.close()
  })
})
