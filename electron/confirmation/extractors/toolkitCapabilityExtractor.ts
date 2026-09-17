import type { FactSignal } from '../../../src/shared/confirmation/types'
import { capabilityRegistry } from '../../capabilities/registry'
import type { CapabilityRegistry } from '../../capabilities/registry'
// 确保单例注册表已装载内置能力（独立使用提取器的场景，如 runExtractors 编排）
import '../../capabilities/registerBuiltinCapabilities'

/**
 * toolkit.call 参数提取器（需求 §5 确认体系）：派生 toolkit-capability 信号，
 * 供 policy 规则按 `toolkit-capability:${id}` / `toolkit-read|toolkit-act` token 配置
 * 各能力确认策略（先例：lark-subcommand → lark-${impact}）。
 * 未知/缺失 id 一律 fail-closed 按 act 处理。
 */
export function createToolkitCapabilityExtractor(registry: CapabilityRegistry = capabilityRegistry) {
  return function extractToolkitCapability(toolInput: Record<string, unknown>): {
    signals: FactSignal[]
    summary: string
  } {
    const id = typeof toolInput.id === 'string' ? toolInput.id : ''
    const descriptor = id ? registry.get(id) : undefined
    if (!descriptor) {
      return {
        signals: [{ kind: 'toolkit-capability', capabilityId: id || '(missing)', risk: 'act' }],
        summary: `toolkit.call · ${id || '(缺少能力 id)'}（未知能力，需确认）`
      }
    }
    const params = JSON.stringify(toolInput.params ?? {})
    const paramsPreview = params.length > 200 ? `${params.slice(0, 200)}…` : params
    return {
      signals: [{ kind: 'toolkit-capability', capabilityId: descriptor.id, risk: descriptor.risk }],
      summary: `toolkit.call · ${descriptor.id}：${descriptor.summary}${descriptor.risk === 'act' ? '（需确认）' : ''}${
        descriptor.risk === 'act' && paramsPreview !== '{}' ? `；参数 ${paramsPreview}` : ''
      }`
    }
  }
}

export const extractToolkitCapability = createToolkitCapabilityExtractor()
