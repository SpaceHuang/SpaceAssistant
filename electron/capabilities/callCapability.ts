import type { CapabilityContext, CapabilityIndexEntry } from './types'
import type { CapabilityRegistry } from './registry'
import { sanitizeCapabilityResult, scrubString } from './sanitize'

/** handler 统一超时上限 */
export const CAPABILITY_TIMEOUT_MS = 10_000
/** 结果序列化尺寸上限（超出截断并附提示） */
export const CAPABILITY_MAX_RESULT_BYTES = 256 * 1024

export type CapabilityErrorCode =
  | 'unknown-capability'
  | 'invalid-params'
  | 'denied'
  | 'failed'
  | 'timeout'

export type CapabilityCallResult =
  | { ok: true; id: string; data: unknown }
  | {
      ok: false
      id: string
      error: {
        code: CapabilityErrorCode
        message: string
        hint: string
        index?: CapabilityIndexEntry[]
      }
    }

export interface CapabilityCallOptions {
  timeoutMs?: number
  maxResultBytes?: number
  /**
   * 确认裁决结果：act 能力在既有确认通道放行后执行；显式传 false 时返回 denied。
   * 缺省视为已放行（read 能力与确认链早于本函数完成的场景）。
   */
  allowed?: boolean
}

const FIND_HINT = '可用 toolkit.find 重新查询调用方式'

class CapabilityTimeoutError extends Error {
  constructor() {
    super('CAPABILITY_TIMEOUT')
    this.name = 'CapabilityTimeoutError'
  }
}

class CapabilityCancelledError extends Error {
  constructor() {
    super('CAPABILITY_CANCELLED')
    this.name = 'CapabilityCancelledError'
  }
}

function zodErrorSummary(error: { issues: Array<{ path: Array<string | number | symbol>; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * toolkit.call 的核心执行流程：
 * id 解析 → lane 校验 → zod 校验 → 风险确认（由既有确认通道在调用前完成）→
 * handler 执行（统一超时）→ 结果脱敏与尺寸上限封装。
 */
export async function callCapability(
  registry: CapabilityRegistry,
  id: string,
  params: unknown,
  ctx: CapabilityContext,
  options?: CapabilityCallOptions
): Promise<CapabilityCallResult> {
  // id 归一化（评审建议 1）：与 match.ts 的 exact 匹配同口径（大小写不敏感），
  // 避免模型以 'Env.System' 直调时 find 可命中而 call 报 unknown 的分裂体验
  const descriptor = registry.get(id) ?? registry.get(id.trim().toLowerCase())
  if (!descriptor) {
    return {
      ok: false,
      id,
      error: {
        code: 'unknown-capability',
        message: `未知能力：${id}`,
        hint: FIND_HINT,
        index: registry.list().map((d) => ({ id: d.id, summary: d.summary }))
      }
    }
  }

  const lane = descriptor.lane ?? 'desktop'
  if (ctx.lane && ctx.lane !== lane) {
    return {
      ok: false,
      id,
      error: { code: 'denied', message: `能力 ${id} 仅在 ${lane} lane 可用（当前：${ctx.lane}）`, hint: FIND_HINT }
    }
  }

  // 纵深防御（评审建议 12）：act 能力要求确认裁决信号。ctx.confirmedByUser === false 表示
  // 确认链明确裁决「未经用户批准」；undefined 为直调/测试场景，不拦截（真实链路恒有值，
  // 且 act 能力经 locked ask 规则必然 require-confirm，到达执行段即已批准）。
  if (descriptor.risk === 'act' && (options?.allowed === false || ctx.confirmedByUser === false)) {
    return {
      ok: false,
      id,
      error: { code: 'denied', message: `能力 ${id} 需要用户确认，本次调用被拒绝`, hint: FIND_HINT }
    }
  }

  const parsed = descriptor.paramsSchema.safeParse(params ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      id,
      error: {
        code: 'invalid-params',
        message: `参数校验失败：${zodErrorSummary(parsed.error)}`,
        hint: FIND_HINT
      }
    }
  }

  const timeoutMs = options?.timeoutMs ?? CAPABILITY_TIMEOUT_MS
  // AbortController 链（评审建议 5）：chat 取消与超时都会 abort handler 收到的 signal，
  // 尽力通知 handler 中止；不监听 signal 的 handler 仍可能后台完成（JS 语义极限）。
  const controller = new AbortController()
  const onCtxAbort = () => controller.abort(new CapabilityCancelledError())
  if (ctx.signal.aborted) onCtxAbort()
  else ctx.signal.addEventListener('abort', onCtxAbort, { once: true })
  // 超时同时做两件事：abort handler signal + 让调用方在时限内返回（race 强制收敛）
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new CapabilityTimeoutError())
      reject(new CapabilityTimeoutError())
    }, timeoutMs)
  })
  timeoutPromise.catch(() => undefined) // handler 先完成时超时分支败者，防 unhandled rejection
  try {
    const raw = await Promise.race([
      descriptor.handler(parsed.data, { ...ctx, signal: controller.signal }),
      timeoutPromise
    ])
    const sanitized = sanitizeCapabilityResult(raw)
    const maxBytes = options?.maxResultBytes ?? CAPABILITY_MAX_RESULT_BYTES
    const serialized = JSON.stringify(sanitized) ?? 'null'
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      return {
        ok: true,
        id,
        data: {
          _truncated: true,
          _originalBytes: Buffer.byteLength(serialized, 'utf8'),
          preview: serialized.slice(0, Math.min(4096, maxBytes))
        }
      }
    }
    return { ok: true, id, data: sanitized }
  } catch (error) {
    if (error instanceof CapabilityTimeoutError) {
      return { ok: false, id, error: { code: 'timeout', message: `能力 ${id} 执行超时（${timeoutMs}ms）`, hint: FIND_HINT } }
    }
    if (error instanceof CapabilityCancelledError || ctx.signal.aborted) {
      return { ok: false, id, error: { code: 'failed', message: '调用已取消（会话中止）', hint: FIND_HINT } }
    }
    // handler 错误消息回给模型前过字符串级打码（评审建议 3：防 handler 把 secret 拼进 Error.message）
    const message = scrubString(error instanceof Error ? error.message : String(error))
    return { ok: false, id, error: { code: 'failed', message, hint: FIND_HINT } }
  } finally {
    if (timer) clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onCtxAbort)
  }
}
