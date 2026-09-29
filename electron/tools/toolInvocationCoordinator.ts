import type { InvocationHandle, InvocationContext, RegisteredTool, ToolExecutionContext } from './plannedToolRegistry'

export interface CoordinatorHooks {
  decide?(prepared: import('./plannedToolRegistry').PreparedInvocation): Promise<boolean>
  confirm?(handle: InvocationHandle): Promise<boolean>
  validate?(handle: InvocationHandle): Promise<void>
  /** Must claim permit-bound dispatch before invoking execute; receives only the typed executor callback. */
  dispatch?(handle: InvocationHandle, context: ToolExecutionContext, execute: (signal: AbortSignal) => Promise<unknown>, onDispatchClaimed?: (cancel: () => void) => void): Promise<unknown>
  phaseTimeoutMs?: Partial<Record<'plan' | 'gate' | 'confirm' | 'validate' | 'execute', number>>
}

async function withPhaseTimeout<T>(phase: string, operation: Promise<T>, timeoutMs: number | undefined, signal: AbortSignal): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return operation
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${phase.toUpperCase()}_TIMEOUT`)), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withPhaseControl<T>(phase: string, operation: Promise<T>, timeoutMs: number | undefined, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(`${phase.toUpperCase()}_CANCELLED`)
  let abortHandler: (() => void) | undefined
  try {
    const cancellation = new Promise<T>((_, reject) => {
      abortHandler = () => reject(new Error(`${phase.toUpperCase()}_CANCELLED`))
      signal.addEventListener('abort', abortHandler, { once: true })
    })
    return await withPhaseTimeout(phase, Promise.race([operation, cancellation]), timeoutMs, signal)
  } finally {
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

async function withDispatchPhaseControl<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  hasClaimed: () => boolean,
  cancelClaimedDispatch: () => void
): Promise<T> {
  if (signal.aborted && !hasClaimed()) throw new Error('EXECUTE_CANCELLED')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  try {
    const interruption = new Promise<T>((_, reject) => {
      abortHandler = () => { if (!hasClaimed()) reject(new Error('EXECUTE_CANCELLED')) }
      signal.addEventListener('abort', abortHandler, { once: true })
    })
    const timeout = timeoutMs && timeoutMs > 0
      ? new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            if (!hasClaimed()) reject(new Error('EXECUTE_TIMEOUT'))
            else cancelClaimedDispatch()
          }, timeoutMs)
        })
      : new Promise<T>(() => undefined)
    return await Promise.race([operation, interruption, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

export async function executeRegisteredTool(
  tool: RegisteredTool,
  raw: unknown,
  context: InvocationContext & { signal: AbortSignal },
  hooks: CoordinatorHooks = {}
): Promise<unknown> {
  const planning = tool.beginPlanning(raw, context)
  const handle = await withPhaseControl('plan', planning.result, hooks.phaseTimeoutMs?.plan, context.signal)
  if (hooks.decide) {
    let decided = false
    try {
      decided = await withPhaseControl('gate', hooks.decide(handle.prepared), hooks.phaseTimeoutMs?.gate, context.signal)
    } catch (error) {
      handle.fail()
      handle.release()
      throw error
    }
    if (!decided) {
      handle.fail()
      handle.release()
      throw new Error('INVOCATION_GATE_REJECTED')
    }
  }
  if (tool.kind === 'planned') handle.awaitConfirmation()
  let approved = false
  try {
    approved = hooks.confirm ? await withPhaseControl('confirm', hooks.confirm(handle), hooks.phaseTimeoutMs?.confirm, context.signal) : false
  } catch (error) {
    handle.fail()
    handle.release()
    throw error
  }
  if (!approved) {
    handle.fail()
    handle.release()
    throw new Error('INVOCATION_NOT_CONFIRMED')
  }
  handle.confirm()
  const { executionContext: _planningContext, ...executionContext } = context
  const executionContextForDispatch = {
    ...executionContext,
    toolName: tool.name,
    runtimeContext: context.executionContext
  } as ToolExecutionContext
  handle.beginValidation()
  try {
    await withPhaseControl('validate', handle.validatePrepared(executionContextForDispatch), hooks.phaseTimeoutMs?.validate, context.signal)
    if (hooks.validate) await withPhaseControl('validate', hooks.validate(handle), hooks.phaseTimeoutMs?.validate, context.signal)
  } catch (error) {
    handle.fail()
    handle.release()
    throw error
  }
  handle.finishValidation()
  const execute = (signal: AbortSignal): Promise<unknown> => handle.execute({
    ...executionContext,
    toolName: tool.name,
    runtimeContext: context.executionContext,
    signal
  } as ToolExecutionContext)
  let dispatchClaimed = false
  let cancelClaimedDispatch: () => void = () => undefined
  try {
    if (!hooks.dispatch) return await withPhaseControl('execute', execute(context.signal), hooks.phaseTimeoutMs?.execute, context.signal)
    const dispatch = hooks.dispatch(handle, executionContextForDispatch, execute, (cancel) => {
      dispatchClaimed = true
      cancelClaimedDispatch = cancel
    })
    return await withDispatchPhaseControl(dispatch, hooks.phaseTimeoutMs?.execute, context.signal, () => dispatchClaimed, () => cancelClaimedDispatch())
  } finally {
    handle.release()
  }
}

/**
 * 供已经由旧 toolChatLoop 完成 Gate/确认的迁移路径使用。
 * 该入口不重新决定授权，只把执行动作切换到 typed registry，并确保
 * handle 的状态、身份校验、异常收敛和 release 仍由同一 coordinator 管理。
 */
export async function executeConfirmedRegisteredTool(
  tool: RegisteredTool,
  raw: unknown,
  context: InvocationContext & { signal: AbortSignal }
): Promise<unknown> {
  const handle = await tool.begin(raw, context)
  try {
    if (tool.kind === 'planned') handle.awaitConfirmation()
    handle.confirm()
    const { executionContext: _planningContext, ...executionContext } = context
    return await handle.execute({
      ...executionContext,
      toolName: tool.name,
      runtimeContext: context.executionContext
    } as ToolExecutionContext)
  } finally {
    handle.release()
  }
}
