import type { CapabilityContext, CapabilityIndexEntry } from './types'
import type { CapabilityRegistry } from './registry'
import { sanitizeCapabilityResult } from './sanitize'

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
  const descriptor = registry.get(id)
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

  if (descriptor.risk === 'act' && options?.allowed === false) {
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
  try {
    // 超时强制收敛：handler 可能不监听 signal，用 race 保证 callCapability 在上限内返回
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CapabilityTimeoutError()), timeoutMs)
      const ctxOnAbort = () => {
        clearTimeout(timer)
        reject(new Error('CAPABILITY_CANCELLED'))
      }
      if (ctx.signal.aborted) {
        ctxOnAbort()
        return
      }
      ctx.signal.addEventListener('abort', ctxOnAbort, { once: true })
      descriptor
        .handler(parsed.data, { ...ctx, signal: ctx.signal })
        .then(
          (value) => {
            clearTimeout(timer)
            ctx.signal.removeEventListener('abort', ctxOnAbort)
            resolve(value)
          },
          (error: unknown) => {
            clearTimeout(timer)
            ctx.signal.removeEventListener('abort', ctxOnAbort)
            reject(error)
          }
        )
    })
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
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, id, error: { code: 'failed', message, hint: FIND_HINT } }
  }
}
