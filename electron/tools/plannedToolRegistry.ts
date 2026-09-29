import { createHash } from 'crypto'
import type { ToolExecutionContext as RuntimeToolExecutionContext } from './types'

const preparedInvocationBrand = Symbol('PreparedInvocation')

export interface InvocationContext {
  requestId: string
  toolUseId: string
  /** 主进程运行时上下文只在 plan 阶段可见，不能随 PreparedInvocation 进入 execute 闭包。 */
  executionContext?: RuntimeToolExecutionContext
}
export interface ToolPlanningContext extends InvocationContext {
  signal: AbortSignal
  /** 计划阶段可读取的宿主运行时快照；planned 工具不得在 execute 阶段重新读取它。 */
  executionContext?: RuntimeToolExecutionContext
}
export interface ToolExecutionContext extends InvocationContext {
  signal: AbortSignal
  toolName?: string
  /** 仅供兼容 planned adapter 传递执行所需 IO 能力；不用于重新计划。 */
  runtimeContext?: RuntimeToolExecutionContext
}

export interface PreparedInvocation {
  readonly [preparedInvocationBrand]: true
  readonly invocationId: string
  readonly requestId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly kind: 'direct' | 'planned'
  /** Hash of the canonical raw tool input accepted by parseInput; no input data is exposed. */
  readonly inputDigest: string
  readonly planDigest: string
  readonly factsDigest: string
  readonly displayDigest: string
}

export type InvocationState =
  | 'planning'
  | 'planned'
  | 'awaiting-confirm'
  | 'confirmed'
  | 'validating'
  | 'executing'
  | 'settled'
  | 'failed'

export interface InvocationHandle {
  readonly prepared: PreparedInvocation
  readonly state: InvocationState
  readonly stateHistory: readonly InvocationState[]
  awaitConfirmation(): void
  confirm(): void
  beginValidation(): void
  finishValidation(): void
  /** Run the host prepared-plan validator before dispatch admission is claimed. */
  validatePrepared(context: ToolExecutionContext): Promise<void>
  fail(): void
  /** 终态后释放私有 plan/execute 闭包引用；可重复调用。 */
  release(): void
  execute(context: ToolExecutionContext): Promise<unknown>
}

export interface PlanningHandle {
  readonly state: 'planning' | 'planned' | 'failed'
  readonly stateHistory: readonly ('planning' | 'planned' | 'failed')[]
  readonly result: Promise<InvocationHandle>
}

export interface RegisteredTool {
  readonly name: string
  readonly kind: 'direct' | 'planned'
  readonly actionClass?: 'read' | 'write' | 'execute' | 'outbound'
  readonly resourceKeys?: (raw: unknown, context?: { workDir: string; sessionId: string }) => readonly string[] | undefined
  begin(raw: unknown, context: InvocationContext): Promise<InvocationHandle>
  /** 可观察的异步 planning 状态；`begin()` 保持向后兼容并复用同一 promise。 */
  beginPlanning(raw: unknown, context: InvocationContext): PlanningHandle
}

export interface DirectToolSpec<I, O> {
  name: string
  actionClass?: RegisteredTool['actionClass']
  resourceKeys?: (input: I, context?: { workDir: string; sessionId: string }) => readonly string[] | undefined
  parseInput(raw: unknown): I
  execute(input: I, context: ToolExecutionContext): Promise<O>
}

export interface PlannedToolSpec<I, P, O> {
  name: string
  actionClass?: RegisteredTool['actionClass']
  resourceKeys?: (input: I, context?: { workDir: string; sessionId: string }) => readonly string[] | undefined
  parseInput(raw: unknown): I
  plan(input: I, context: ToolPlanningContext): Promise<P>
  execute(plan: P, context: ToolExecutionContext): Promise<O>
  validate?(plan: P, context: ToolExecutionContext): Promise<void> | void
  facts?(plan: P): unknown
  display?(plan: P): unknown
}

export class TypedToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`TOOL_ALREADY_REGISTERED:${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  entries(): readonly RegisteredTool[] {
    return [...this.tools.values()]
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function assertCanonicalJsonInput(value: unknown): void {
  const seen = new WeakSet<object>()
  const visit = (current: unknown): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (Number.isFinite(current)) return
      throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    }
    if (typeof current !== 'object') throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    if (seen.has(current)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    seen.add(current)

    const array = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    }
    const keys = Reflect.ownKeys(current)
    if (keys.some((key) => typeof key === 'symbol')) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    const propertyKeys = array ? keys.filter((key) => key !== 'length') : keys
    if (array && propertyKeys.length !== current.length) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    for (const key of propertyKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
      if (array && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) {
        throw new Error('INVALID_CANONICAL_TOOL_INPUT')
      }
      visit(descriptor.value)
    }
  }

  try { visit(value) }
  catch { throw new Error('INVALID_CANONICAL_TOOL_INPUT') }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function makeHandle(
  name: string,
  kind: 'direct' | 'planned',
  payload: unknown,
  context: InvocationContext,
  executeFn: (context: ToolExecutionContext) => Promise<unknown>,
  facts: unknown = payload,
  display: unknown = payload,
  initialState: InvocationState = 'awaiting-confirm',
  initialHistory: readonly InvocationState[] = [],
  validateFn: (context: ToolExecutionContext) => Promise<void> | void = () => undefined,
  inputDigest: string = digest(payload)
): InvocationHandle {
  let confirmed = false
  let executed = false
  let released = false
  let currentExecuteFn: ((context: ToolExecutionContext) => Promise<unknown>) | undefined = executeFn
  let state: InvocationState = initialState
  const stateHistory: InvocationState[] = [...initialHistory, initialState]
  const transition = (next: InvocationState): void => {
    state = next
    stateHistory.push(next)
  }
  const frozenPayload = deepFreeze(payload)
  const frozenFacts = deepFreeze(structuredClone(facts))
  const frozenDisplay = deepFreeze(structuredClone(display))
  const prepared = Object.freeze({
    [preparedInvocationBrand]: true as const,
    invocationId: crypto.randomUUID(), requestId: context.requestId, toolUseId: context.toolUseId,
    toolName: name, kind, inputDigest, planDigest: digest(frozenPayload), factsDigest: digest(frozenFacts), displayDigest: digest(frozenDisplay)
  })
  return {
    prepared,
    get state() { return state },
    get stateHistory() { return [...stateHistory] },
    awaitConfirmation: () => {
      if (state !== 'planned') throw new Error('INVOCATION_INVALID_PLANNED_STATE')
      transition('awaiting-confirm')
    },
    confirm: () => {
      if (state !== 'awaiting-confirm') throw new Error('INVOCATION_INVALID_CONFIRM_STATE')
      confirmed = true
      transition('confirmed')
    },
    beginValidation: () => {
      if (!confirmed || state !== 'confirmed') throw new Error('INVOCATION_NOT_CONFIRMED')
      transition('validating')
    },
    finishValidation: () => {
      if (state !== 'validating') throw new Error('INVOCATION_NOT_VALIDATING')
      transition('confirmed')
    },
    validatePrepared: async (context) => {
      if (state !== 'validating') throw new Error('INVOCATION_NOT_VALIDATING')
      await validateFn(context)
    },
    fail: () => {
      if (state !== 'settled' && state !== 'failed') transition('failed')
    },
    release: () => {
      if (released) return
      released = true
      currentExecuteFn = undefined
    },
    execute: async (context) => {
      if (executed) throw new Error('INVOCATION_ALREADY_EXECUTED')
      if (state === 'failed') throw new Error('INVOCATION_ALREADY_FAILED')
      if (state === 'settled') throw new Error('INVOCATION_ALREADY_SETTLED')
      if (!confirmed) throw new Error('INVOCATION_NOT_CONFIRMED')
      if (context.requestId !== prepared.requestId || context.toolUseId !== prepared.toolUseId) {
        throw new Error('INVOCATION_IDENTITY_MISMATCH')
      }
      if (context.toolName && context.toolName !== prepared.toolName) {
        throw new Error('INVOCATION_TOOL_IDENTITY_MISMATCH')
      }
      executed = true
      transition('executing')
      try {
        const run = currentExecuteFn
        if (!run) throw new Error('INVOCATION_PLAN_RELEASED')
        const result = await run(context)
        transition('settled')
        return result
      } catch (error) {
        transition('failed')
        throw error
      }
    }
  }
}

function makePlanningHandle(begin: () => Promise<InvocationHandle>): PlanningHandle {
  let state: PlanningHandle['state'] = 'planning'
  const history: PlanningHandle['stateHistory'][number][] = ['planning']
  const result = begin()
  void result.then(() => {
    state = 'planned'
    history.push('planned')
  }, (error) => {
    state = 'failed'
    history.push('failed')
    return error
  })
  return {
    get state() { return state },
    get stateHistory() { return [...history] },
    result
  }
}

export function defineDirectTool<I, O>(spec: DirectToolSpec<I, O>): RegisteredTool {
  const begin = async (raw: unknown, context: InvocationContext): Promise<InvocationHandle> => {
    assertCanonicalJsonInput(raw)
    const inputDigest = digest(raw)
    const input = spec.parseInput(raw)
    return makeHandle(spec.name, 'direct', input, context, (execution) => spec.execute(input, execution), input, input, undefined, [], undefined, inputDigest)
  }
  return {
    name: spec.name,
    kind: 'direct',
    ...(spec.actionClass ? { actionClass: spec.actionClass } : {}),
    ...(spec.resourceKeys ? { resourceKeys: (raw, context) => spec.resourceKeys!(spec.parseInput(raw), context) } : {}),
    begin,
    beginPlanning: (raw, context) => makePlanningHandle(() => begin(raw, context))
  }
}

export function definePlannedTool<I, P, O>(spec: PlannedToolSpec<I, P, O>): RegisteredTool {
  const begin = async (raw: unknown, context: InvocationContext): Promise<InvocationHandle> => {
    assertCanonicalJsonInput(raw)
    const inputDigest = digest(raw)
    const input = spec.parseInput(raw)
    const signal = (context as InvocationContext & { signal?: AbortSignal }).signal ?? new AbortController().signal
    if (signal.aborted) throw new Error('PLAN_CANCELLED')
    const plan = await spec.plan(input, { ...context, signal })
    if (signal.aborted) throw new Error('PLAN_CANCELLED')
    const frozenPlan = structuredClone(plan)
    const validate = async (execution: ToolExecutionContext): Promise<void> => {
      if (spec.validate) await spec.validate(frozenPlan, execution)
    }
    return makeHandle(
      spec.name, 'planned', frozenPlan, context,
      async (execution) => {
        await validate(execution)
        return spec.execute(frozenPlan, execution)
      },
      spec.facts ? spec.facts(frozenPlan) : frozenPlan,
      spec.display ? spec.display(frozenPlan) : frozenPlan,
      'planned',
      ['planning'],
      validate,
      inputDigest
    )
  }
  return {
    name: spec.name,
    kind: 'planned',
    ...(spec.actionClass ? { actionClass: spec.actionClass } : {}),
    ...(spec.resourceKeys ? { resourceKeys: (raw, context) => spec.resourceKeys!(spec.parseInput(raw), context) } : {}),
    begin,
    beginPlanning: (raw, context) => makePlanningHandle(() => begin(raw, context))
  }
}
